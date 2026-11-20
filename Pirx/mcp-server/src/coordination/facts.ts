import { existsSync, readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { pidAlive } from "./proc.js";
import { failure, jsonOf, type Runner } from "./shell.js";

export { pidAlive, processStart } from "./proc.js";
import { findRepository, type CoordinatedRepository, type CoordinationSettings } from "./settings.js";
import { taskKey, type CoordinationStore } from "./store.js";
import { defineTool, issueInput, refuse, repositoryInput, type CoordinationContext } from "./toolkit.js";

export function tail(text: string, lines: number): string {
  const all = text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function readIfExists(path: string): string | undefined {
  try { return existsSync(path) ? readFileSync(path, "utf8") : undefined; } catch { return undefined; }
}

export function repositoryOrRefusal(settings: CoordinationSettings, repository: string): CoordinatedRepository | Record<string, unknown> {
  return findRepository(settings, repository) ?? refuse(`${repository} is not an allowlisted repository.`, { allowlisted: settings.repositories.map((item) => item.repository) });
}
export function isRefusal(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).refused === true;
}

/** Finds the Task's branch and worktree: Pirx's own record first, then any `pirx/*` worktree of this Issue (e.g. from the old daemon). */
export async function locateWorkspace(run: Runner, store: CoordinationStore, repo: CoordinatedRepository, issue: number): Promise<{ branch: string; worktree: string; source: "pirx" | "found" } | undefined> {
  const own = store.getTask(taskKey(repo.repository, issue));
  if (own !== undefined) return { branch: own.branch, worktree: own.worktree, source: "pirx" };
  const listed = await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.repositoryRoot });
  if (!listed.ok) return undefined;
  let path: string | undefined;
  const pattern = new RegExp(`^refs/heads/(pirx/(?:[^ ]*[-/])?(?:gh-)?${issue}(?:[-/][^ ]*)?)$`, "u");
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    const match = line.startsWith("branch ") && !line.startsWith("branch refs/heads/pirx/archive/") ? pattern.exec(line.slice(7)) : null;
    if (match !== null && path !== undefined && existsSync(path)) return { branch: match[1]!, worktree: path, source: "found" };
  }
  return undefined;
}

export async function workspaceFacts(run: Runner, repo: CoordinatedRepository, branch: string, worktree: string): Promise<Record<string, unknown>> {
  if (!existsSync(worktree)) return { branch, worktree, exists: false };
  const base = `${repo.remoteName}/${repo.baseBranch}`;
  await run("git", ["fetch", "--quiet", repo.remoteName, repo.baseBranch, branch], { cwd: worktree, timeoutMs: 60_000 });
  const [head, status, log, behind, remote] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: worktree }),
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: worktree }),
    run("git", ["log", "--format=%h %s (%cr)", `${base}..HEAD`], { cwd: worktree }),
    run("git", ["rev-list", "--count", `HEAD..${base}`], { cwd: worktree }),
    run("git", ["rev-parse", "--verify", "--quiet", `${repo.remoteName}/${branch}`], { cwd: worktree }),
  ]);
  const commits = log.ok ? log.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    branch, worktree, exists: true,
    head: head.stdout.trim(),
    clean: status.ok && status.stdout.trim().length === 0,
    ...(status.stdout.trim() ? { uncommitted: status.stdout.trim().split("\n") } : {}),
    commitsAheadOfBase: commits,
    commitsBehindBase: Number(behind.stdout.trim() || 0),
    pushed: remote.ok ? { remoteHead: remote.stdout.trim(), upToDate: remote.stdout.trim() === head.stdout.trim() } : false,
  };
}

function parseReport(text: string): unknown {
  try { return JSON.parse(text); } catch { return { unreadable: text }; }
}

export function workerFacts(store: CoordinationStore, task?: string): Record<string, unknown> {
  const lock = store.lock();
  if (lock === undefined || (task !== undefined && lock.task !== task)) return { running: false };
  const alive = pidAlive(lock.pid, lock.pidStart);
  const report = readIfExists(lock.reportPath);
  const hasReport = report !== undefined && report.trim() !== "";
  return {
    running: alive, task: lock.task, pid: lock.pid, startedAt: lock.startedAt, logPath: lock.logPath,
    ...(alive ? {} : hasReport
      ? { exited: true, note: "The worker process has ended. Read its report, then decide; the next worker_start or worker_resume clears this lock." }
      : { exited: true, endedWithoutReport: true, note: "The worker process is gone and wrote no report: it was killed or crashed, not finished. Check the worktree in task_facts (commits, uncommitted files) before resuming; this start does not count against the daily cap." }),
    ...(hasReport ? { report: parseReport(report) } : {}),
    // The log is raw stream-json; whole lines run to tens of kilobytes. The report carries the worker's own words.
    logTail: tail(readIfExists(lock.logPath) ?? "", 6).split("\n").map((line) => line.length > 300 ? `${line.slice(0, 300)}… (${line.length} characters, full log at logPath)` : line),
  };
}

/** Counts per conclusion, and the name of every check that is not a success or a skip. */
function summariseChecks(checks: Record<string, unknown>[] | undefined): Record<string, unknown> {
  const counts: Record<string, number> = {}; const notGreen: Record<string, unknown>[] = [];
  for (const check of checks ?? []) {
    const conclusion = String(check.conclusion ?? check.state ?? check.status ?? "UNKNOWN");
    counts[conclusion] = (counts[conclusion] ?? 0) + 1;
    if (!["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion)) notGreen.push({ name: check.name ?? check.context, status: check.status, conclusion, workflow: check.workflowName });
  }
  return { counts, notGreen };
}

export function registerFactTools(server: McpServer, context: CoordinationContext): void {
  const { settings } = context;

  defineTool(server, context, {
    name: "queue_list",
    description: "The work queue: open Issues of allowlisted repositories on the GitHub Project, with Status, Worker, Queue Order, Priority, Risk and Work Type, lowest Queue Order first. Only Worker=Pirx items are Pirx's to do.",
    input: { includeAll: z.boolean().optional().describe("Also list items whose Worker is not Pirx or whose Status is Done.") },
    mutating: false,
    run: async (input, { run }) => {
      if (settings.projectOwner === undefined || settings.projectNumber === undefined) return { error: "No GitHub Project is configured (githubProjectOwner/githubProjectNumber)." };
      const result = await run("gh", ["project", "item-list", String(settings.projectNumber), "--owner", settings.projectOwner, "--format", "json", "--limit", "500"], { timeoutMs: 60_000 });
      const value = jsonOf(result) as { items?: Record<string, unknown>[] } | undefined;
      if (value === undefined) return failure(result);
      const allowed = new Set(settings.repositories.map((item) => item.repository.toLowerCase()));
      const items = (value.items ?? []).flatMap((item) => {
        const content = item.content as { number?: number; repository?: string; title?: string; type?: string; url?: string } | undefined;
        if (content?.type !== "Issue" || content.repository === undefined || !allowed.has(content.repository.toLowerCase())) return [];
        const status = item.status as string | undefined; const worker = item.worker as string | undefined;
        if (input.includeAll !== true && (status === "Done" || worker !== "Pirx")) return [];
        return [{ repository: content.repository, issue: content.number, title: content.title, status, worker, queueOrder: item["queue Order"], priority: item.priority, risk: item.risk, workType: item["work Type"], labels: item.labels, url: content.url }];
      }).sort((a, b) => Number(a.queueOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.queueOrder ?? Number.MAX_SAFE_INTEGER));
      return items.length === 0 ? { items: [], note: "Nothing is queued for Pirx." } : { items };
    },
  });

  defineTool(server, context, {
    name: "issue_list",
    description: "List Issues of an allowlisted repository, with labels and the PRs that close them. Filter by state, label and search text. An empty result means no Issue matches.",
    input: { repository: repositoryInput, state: z.enum(["open", "closed", "all"]).optional(), label: z.string().optional(), search: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    mutating: false,
    run: async (input, { run }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const args = ["issue", "list", "-R", input.repository, "--state", input.state ?? "open", "--limit", String(input.limit ?? 30), "--json", "number,title,state,labels,updatedAt,closedByPullRequestsReferences,url"];
      if (input.label !== undefined) args.push("--label", input.label);
      if (input.search !== undefined) args.push("--search", input.search);
      const result = await run("gh", args);
      const issues = jsonOf(result) as Record<string, unknown>[] | undefined;
      if (issues === undefined) return failure(result);
      const shaped = issues.map((issue) => ({ issue: issue.number, title: issue.title, state: issue.state, labels: (issue.labels as { name: string }[] | undefined)?.map((label) => label.name), updatedAt: issue.updatedAt, closedBy: (issue.closedByPullRequestsReferences as { number: number; url: string }[] | undefined)?.map((pr) => pr.number), url: issue.url }));
      return shaped.length === 0 ? { issues: [], note: "No Issue matches. That is a complete answer; searching again with other words will not change it." } : { issues: shaped };
    },
  });

  defineTool(server, context, {
    name: "pr_list",
    description: "Recent pull requests of an allowlisted repository and the Issues each one closes or mentions. Use it before dispatching work, to see whether someone already did it.",
    input: { repository: repositoryInput, state: z.enum(["open", "merged", "closed", "all"]).optional(), search: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    mutating: false,
    run: async (input, { run }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const args = ["pr", "list", "-R", input.repository, "--state", input.state ?? "all", "--limit", String(input.limit ?? 20), "--json", "number,title,state,headRefName,baseRefName,mergedAt,closingIssuesReferences,url,body"];
      if (input.search !== undefined) args.push("--search", input.search);
      const result = await run("gh", args);
      const prs = jsonOf(result) as Record<string, unknown>[] | undefined;
      if (prs === undefined) return failure(result);
      const shaped = prs.map((pr) => ({
        pr: pr.number, title: pr.title, state: pr.state, branch: pr.headRefName, base: pr.baseRefName, mergedAt: pr.mergedAt, url: pr.url,
        closes: (pr.closingIssuesReferences as { number: number }[] | undefined)?.map((issue) => issue.number),
        mentions: [...new Set([...`${String(pr.title)} ${String(pr.body)} ${String(pr.headRefName)}`.matchAll(/(?:#|gh-)(\d+)/gu)].map((match) => Number(match[1])))],
      }));
      return shaped.length === 0 ? { prs: [], note: "No pull request matches." } : { prs: shaped };
    },
  });

  defineTool(server, context, {
    name: "ci_status",
    description: "CI for a pull request, branch or commit: each check with its state, and for failed workflow runs the run id and the tail of the failed log. Use the run id with ci_rerun.",
    input: { repository: repositoryInput, pr: z.number().int().positive().optional(), branch: z.string().optional(), commit: z.string().optional() },
    mutating: false,
    run: async (input, { run }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const filter = input.commit !== undefined ? ["--commit", input.commit] : input.branch !== undefined ? ["--branch", input.branch] : undefined;
      const facts: Record<string, unknown> = {};
      if (input.pr !== undefined) {
        const checks = await run("gh", ["pr", "checks", String(input.pr), "-R", input.repository, "--json", "name,state,bucket,workflow,link"]);
        facts.checks = jsonOf(checks) ?? failure(checks);
      }
      let runsArgs = filter;
      if (runsArgs === undefined && input.pr !== undefined) {
        const head = jsonOf(await run("gh", ["pr", "view", String(input.pr), "-R", input.repository, "--json", "headRefOid"])) as { headRefOid?: string } | undefined;
        if (head?.headRefOid !== undefined) runsArgs = ["--commit", head.headRefOid];
      }
      if (runsArgs === undefined) return refuse("Give a pr, branch or commit.");
      const runs = await run("gh", ["run", "list", "-R", input.repository, ...runsArgs, "--limit", "20", "--json", "databaseId,workflowName,status,conclusion,event,headBranch,headSha,createdAt,url,attempt"]);
      const list = jsonOf(runs) as Record<string, unknown>[] | undefined;
      if (list === undefined) return { ...facts, runs: failure(runs) };
      for (const item of list.filter((entry) => entry.conclusion === "failure").slice(0, 3)) {
        const log = await run("gh", ["run", "view", String(item.databaseId), "-R", input.repository, "--log-failed"], { timeoutMs: 120_000 });
        item.failedLogTail = log.ok ? tail(log.stdout, 60) : failure(log);
      }
      facts.runs = list.length === 0 ? { runs: [], note: "No workflow run for this ref." } : list;
      return facts;
    },
  });

  defineTool(server, context, {
    name: "worker_status",
    description: "Whether the worker is running, for which Task, since when, the tail of its log, and its final report once it has exited.",
    input: {},
    mutating: false,
    run: async (_input, { store }) => workerFacts(store),
  });

  defineTool(server, context, {
    name: "task_facts",
    description: "Everything about one Task in one call, by its Issue number (not a pull request number; events name both): the Issue, Pirx's record of the Task, its worktree (HEAD, clean or not, commits ahead of and behind the base, pushed or not), its pull requests with merge state and checks, the worker, and Pirx's last journal entries for it.",
    input: { repository: repositoryInput, issue: issueInput },
    mutating: false,
    task: (input) => taskKey(input.repository, input.issue),
    run: async (input, { run, store }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const key = taskKey(input.repository, input.issue);
      const issueResult = await run("gh", ["issue", "view", String(input.issue), "-R", input.repository, "--json", "number,title,state,body,labels,closedByPullRequestsReferences,updatedAt,url"]);
      const issue = jsonOf(issueResult) ?? failure(issueResult);
      const workspace = await locateWorkspace(run, store, repo, input.issue);
      const facts: Record<string, unknown> = { task: key, issue, pirxRecord: store.getTask(key) ?? null };
      if (workspace === undefined) facts.workspace = { exists: false, note: "No worktree for this Issue yet." };
      else {
        facts.workspace = { ...(await workspaceFacts(run, repo, workspace.branch, workspace.worktree)), recordedBy: workspace.source === "pirx" ? "pirx" : "found on disk (not created by Pirx's tools)" };
        const prs = await run("gh", ["pr", "list", "-R", input.repository, "--head", workspace.branch, "--state", "all", "--json", "number,state,url,baseRefName,headRefOid,isDraft,mergeable,mergeStateStatus,mergedAt,mergeCommit,statusCheckRollup"]);
        const list = jsonOf(prs) as Record<string, unknown>[] | undefined;
        facts.pullRequests = list === undefined ? failure(prs) : list.length === 0 ? { prs: [], note: "No pull request from this branch." } : list.map((pr) => ({
          ...pr,
          statusCheckRollup: undefined,
          checks: summariseChecks(pr.statusCheckRollup as Record<string, unknown>[] | undefined),
        }));
      }
      facts.worker = workerFacts(store, key);
      facts.journal = store.journal({ task: key, limit: 8 }).map((entry) => ({ seq: entry.seq, at: entry.at, kind: entry.kind, name: entry.name, ok: entry.ok }));
      return facts;
    },
  });
}
