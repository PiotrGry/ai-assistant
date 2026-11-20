import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { isRefusal, issueOfBranch, locateWorkspace, repositoryOrRefusal, workerFacts, workspaceFacts } from "./facts.js";
import { createHash } from "node:crypto";

import { failure, jsonOf, type Runner } from "./shell.js";
import { startOfDay, type CoordinationSettings } from "./settings.js";
import { taskKey } from "./store.js";
import { WORKER_ENV_ALLOWLIST } from "./worker.js";
import { defineTool, issueInput, refuse, repositoryInput, type CoordinationContext } from "./toolkit.js";

/** Every Issue Pirx creates carries this label, and only one may be open at a time. */
const PROPOSAL_LABEL = "pirx-round";
/** A production bug Pirx found itself. It may queue these in a tick; improvements wait for the operator. */
const BUG_LABEL = "pirx-bug";
const MAX_OPEN_BUGS = 5;

/** The same error reworded is the same bug: numbers, ids, quotes and case are dropped before hashing. */
export function bugFingerprint(text: string): string {
  const stem = text.toLowerCase().replace(/[0-9a-f]{8,}/gu, "#").replace(/\d+/gu, "#").replace(/['"`]/gu, "").replace(/[^a-z#|:/._ -]+/gu, " ").replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(stem).digest("hex").slice(0, 16);
}

const PIRX_BRANCH = /^pirx\/(?!archive\/)[A-Za-z0-9._/-]+$/u;

async function projectIds(run: Runner, settings: CoordinationSettings): Promise<{ projectId: string; fields: Record<string, { id: string; options: Record<string, string> }> } | Record<string, unknown>> {
  if (settings.projectOwner === undefined || settings.projectNumber === undefined) return { error: "No GitHub Project is configured." };
  const view = await run("gh", ["project", "view", String(settings.projectNumber), "--owner", settings.projectOwner, "--format", "json"]);
  const project = jsonOf(view) as { id?: string } | undefined;
  if (project?.id === undefined) return failure(view);
  const fieldList = await run("gh", ["project", "field-list", String(settings.projectNumber), "--owner", settings.projectOwner, "--format", "json"]);
  const value = jsonOf(fieldList) as { fields?: { id: string; name: string; options?: { id: string; name: string }[] }[] } | undefined;
  if (value === undefined) return failure(fieldList);
  const fields: Record<string, { id: string; options: Record<string, string> }> = {};
  for (const field of value.fields ?? []) fields[field.name] = { id: field.id, options: Object.fromEntries((field.options ?? []).map((option) => [option.name, option.id])) };
  return { projectId: project.id, fields };
}

export function registerActionTools(server: McpServer, context: CoordinationContext): void {
  const { settings } = context;
  const taskOf = (input: { repository: string; issue: number }): string => taskKey(input.repository, input.issue);

  defineTool(server, context, {
    name: "task_ship",
    description: "Push the Task's branch (never forced) and open its pull request against the base branch, or return the open one. Refuses when the worktree has uncommitted changes, when there is nothing new to ship, or when the branch is not a pirx/* branch.",
    input: { repository: repositoryInput, issue: issueInput, title: z.string().min(1), body: z.string().min(1) },
    mutating: true,
    task: taskOf,
    run: async (input, { run, store }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const workspace = await locateWorkspace(run, store, repo, input.issue);
      if (workspace === undefined || !existsSync(workspace.worktree)) return refuse("This Task has no worktree; nothing to ship.");
      if (!PIRX_BRANCH.test(workspace.branch)) return refuse(`Only pirx/* branches are shipped; this one is ${workspace.branch}.`);
      if (workerFacts(store, taskOf(input)).running === true) return refuse("The worker is still running on this Task.");
      const facts = await workspaceFacts(run, repo, workspace.branch, workspace.worktree);
      if (facts.clean !== true) return refuse("The worktree has uncommitted changes. Ask the worker to commit or discard them.", { workspace: facts });
      if ((facts.commitsAheadOfBase as unknown[]).length === 0) return refuse("The branch has no commits beyond the base; there is nothing to ship.", { workspace: facts });
      const pushed = await run("git", ["push", repo.remoteName, `HEAD:refs/heads/${workspace.branch}`], { cwd: workspace.worktree, timeoutMs: 15 * 60 * 1000 });
      if (!pushed.ok) return failure(pushed, "A rejected push is not retried by force. If the remote branch moved, inspect it; if a pre-push hook failed, resume the worker with its output.");
      const open = jsonOf(await run("gh", ["pr", "list", "-R", input.repository, "--head", workspace.branch, "--state", "open", "--json", "number,url"])) as { number: number; url: string }[] | undefined;
      if (open !== undefined && open.length > 0) return { pushed: true, pr: open[0], note: "The pull request already existed; it now has the pushed commits." };
      const body = /#\d+/u.test(input.body) ? input.body : `${input.body}\n\nRefs #${input.issue}`;
      const created = await run("gh", ["pr", "create", "-R", input.repository, "--base", repo.baseBranch, "--head", workspace.branch, "--title", input.title, "--body", body]);
      if (!created.ok) return { pushed: true, ...failure(created) };
      return { pushed: true, pr: { url: created.stdout.trim() } };
    },
  });

  defineTool(server, context, {
    name: "pr_update_branch",
    description: "Bring a pull request's branch up to date with its base by merging the base into it on GitHub (no rebase, no force). Use it when the PR is behind its base.",
    input: { repository: repositoryInput, pr: z.number().int().positive() },
    mutating: true,
    run: async (input, { run }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const head = jsonOf(await run("gh", ["pr", "view", String(input.pr), "-R", input.repository, "--json", "headRefName,state"])) as { headRefName?: string; state?: string } | undefined;
      if (head?.headRefName === undefined || !PIRX_BRANCH.test(head.headRefName)) return refuse("Only pull requests from pirx/* branches are updated.", { head });
      const result = await run("gh", ["pr", "update-branch", String(input.pr), "-R", input.repository]);
      return result.ok ? { updated: true, output: result.stdout.trim() || result.stderr.trim() } : failure(result, "A merge conflict needs the worker: resume it with the conflict to resolve.");
    },
  });

  defineTool(server, context, {
    name: "ci_rerun",
    description: "Rerun the failed jobs of one workflow run, e.g. after a network timeout that has nothing to do with the change. Capped per run.",
    input: { repository: repositoryInput, runId: z.number().int().positive(), issue: issueInput.optional() },
    mutating: true,
    task: (input) => input.issue === undefined ? undefined : taskKey(input.repository, input.issue),
    run: async (input, { run, store }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const used = store.journal({ kind: "tool", limit: 500 }).filter((entry) => entry.name === "ci_rerun" && entry.ok && (entry.input as { runId?: number } | undefined)?.runId === input.runId).length;
      if (used >= settings.caps.ciRerunsPerRun) return refuse(`Run ${input.runId} was already rerun ${used} times; the cap is ${settings.caps.ciRerunsPerRun}. The failure is probably real: read the log and decide.`);
      const result = await run("gh", ["run", "rerun", String(input.runId), "--failed", "-R", input.repository]);
      return result.ok ? { rerun: true, runId: input.runId, note: "Check ci_status again when the run finishes." } : failure(result);
    },
  });

  defineTool(server, context, {
    name: "task_adopt_commit",
    description: "Accept the commit the worker left in the Task's worktree as the Task's current state (e.g. it committed, then its usage limit ran out). Checks that the commit is the worktree's HEAD on the Task branch. Then resume the worker or ship.",
    input: { repository: repositoryInput, issue: issueInput, commit: z.string().regex(/^[0-9a-f]{7,40}$/u) },
    mutating: true,
    task: taskOf,
    run: async (input, { run, store }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const workspace = await locateWorkspace(run, store, repo, input.issue);
      if (workspace === undefined) return refuse("This Task has no worktree.");
      const head = await run("git", ["rev-parse", "HEAD"], { cwd: workspace.worktree });
      if (!head.ok || !head.stdout.trim().startsWith(input.commit)) return refuse(`The worktree HEAD is ${head.stdout.trim()}, not ${input.commit}.`);
      const own = store.getTask(taskOf(input));
      store.upsertTask({ repository: repo.repository, issue: input.issue, branch: workspace.branch, worktree: workspace.worktree, ...(own?.sessionId === undefined ? {} : { sessionId: own.sessionId }), state: "active", note: `Adopted ${head.stdout.trim()}` });
      return { adopted: head.stdout.trim(), branch: workspace.branch, worktree: workspace.worktree };
    },
  });

  defineTool(server, context, {
    name: "task_restart_clean",
    description: "Set the Task's current worktree aside (moved and its branch renamed to pirx/archive/..., nothing deleted) so worker_start can begin again from the current base.",
    input: { repository: repositoryInput, issue: issueInput, reason: z.string().min(1) },
    mutating: true,
    task: taskOf,
    run: async (input, { run, store }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      if (workerFacts(store, taskOf(input)).running === true) return refuse("The worker is still running on this Task.");
      const workspace = await locateWorkspace(run, store, repo, input.issue);
      if (workspace === undefined || !existsSync(workspace.worktree)) return { nothingToArchive: true, note: "No worktree exists; worker_start can begin." };
      const stamp = store.now().replace(/[:.]/gu, "-");
      const archivedPath = `${workspace.worktree}.archived-${stamp}`;
      const moved = await run("git", ["worktree", "move", workspace.worktree, archivedPath], { cwd: repo.repositoryRoot });
      if (!moved.ok) return failure(moved);
      const archivedBranch = `pirx/archive/${workspace.branch.replace(/^pirx\//u, "")}-${stamp}`;
      const renamed = await run("git", ["branch", "-m", workspace.branch, archivedBranch], { cwd: archivedPath });
      if (!renamed.ok) return { moved: archivedPath, ...failure(renamed) };
      store.upsertTask({ repository: repo.repository, issue: input.issue, branch: archivedBranch, worktree: archivedPath, state: "active", note: `Restarted clean: ${input.reason}` });
      return { archived: { worktree: archivedPath, branch: archivedBranch }, note: "worker_start can now begin from the current base." };
    },
  });

  defineTool(server, context, {
    name: "task_park",
    description: "Set a Task aside with a reason, e.g. waiting for the operator or blocked outside the code. Parked Tasks stay visible in the journal and in task_facts.",
    input: { repository: repositoryInput, issue: issueInput, reason: z.string().min(1) },
    mutating: true,
    task: taskOf,
    run: async (input, { run, store }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const own = store.getTask(taskOf(input));
      const workspace = own ?? await locateWorkspace(run, store, repo, input.issue);
      store.upsertTask({ repository: repo.repository, issue: input.issue, branch: workspace?.branch ?? "", worktree: workspace?.worktree ?? "", ...(own?.sessionId === undefined ? {} : { sessionId: own.sessionId }), state: "parked", note: input.reason });
      return { parked: true, reason: input.reason };
    },
  });

  defineTool(server, context, {
    name: "task_close",
    description: "Close the Issue with evidence, then delete the Task's remote pirx/* branch and its worktree. Refuses unless the pull request that carries the change (the Task's own, or the one given) is merged and its merge commit is on the repository's target branch.",
    input: { repository: repositoryInput, issue: issueInput, evidence: z.string().min(1), pr: z.number().int().positive().optional() },
    mutating: true,
    task: taskOf,
    run: async (input, { run, store }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const workspace = await locateWorkspace(run, store, repo, input.issue);
      let prs: { number: number; mergeCommit?: { oid: string } | null; state: string }[] | undefined;
      if (input.pr !== undefined) {
        const pr = jsonOf(await run("gh", ["pr", "view", String(input.pr), "-R", input.repository, "--json", "number,state,mergeCommit,title,body,headRefName,closingIssuesReferences"])) as { number: number; state: string; mergeCommit?: { oid: string } | null; title?: string; body?: string; headRefName?: string; closingIssuesReferences?: { number: number }[] } | undefined;
        if (pr === undefined) return refuse(`Cannot read PR #${input.pr}.`);
        // The PR must belong to this Issue: it closes it, names it, or comes from its branch. Any merged number is not enough.
        const mentions = new RegExp(`(^|[^0-9])#${input.issue}([^0-9]|$)`, "u");
        const related = (pr.closingIssuesReferences ?? []).some((issue) => issue.number === input.issue)
          || mentions.test(`${pr.title ?? ""} ${pr.body ?? ""}`)
          || (pr.headRefName !== undefined && (pr.headRefName === workspace?.branch || issueOfBranch(pr.headRefName) === input.issue));
        if (!related) return refuse(`PR #${pr.number} does not close or mention #${input.issue} and is not from its branch. Give the PR that carries this change.`, { pr: { number: pr.number, title: pr.title, branch: pr.headRefName } });
        prs = [pr];
      }
      else if (workspace !== undefined) prs = jsonOf(await run("gh", ["pr", "list", "-R", input.repository, "--head", workspace.branch, "--state", "merged", "--json", "number,state,mergeCommit"])) as typeof prs;
      const merged = prs?.find((pr) => pr?.state === "MERGED" && pr.mergeCommit?.oid !== undefined);
      if (merged === undefined) return refuse("No merged pull request carries this change. Give the pr that fixed it, or ship and merge first.", { prs });
      await run("git", ["fetch", "--quiet", repo.remoteName, repo.targetBranch], { cwd: repo.repositoryRoot, timeoutMs: 120_000 });
      const reached = await run("git", ["merge-base", "--is-ancestor", merged.mergeCommit!.oid, `${repo.remoteName}/${repo.targetBranch}`], { cwd: repo.repositoryRoot });
      if (!reached.ok) return refuse(`PR #${merged.number} is merged, but its merge commit is not on ${repo.targetBranch} yet. Wait for the repository's own delivery.`);
      const closed = await run("gh", ["issue", "close", String(input.issue), "-R", input.repository, "--reason", "completed", "--comment", input.evidence]);
      if (!closed.ok && !/already closed/iu.test(closed.stderr)) return failure(closed);
      const cleanup: Record<string, unknown> = {};
      if (workspace !== undefined && PIRX_BRANCH.test(workspace.branch)) {
        const deleted = await run("git", ["push", repo.remoteName, "--delete", workspace.branch], { cwd: repo.repositoryRoot });
        cleanup.remoteBranch = deleted.ok ? "deleted" : deleted.stderr.trim();
        if (existsSync(workspace.worktree)) {
          const removed = await run("git", ["worktree", "remove", "--force", workspace.worktree], { cwd: repo.repositoryRoot });
          cleanup.worktree = removed.ok ? "removed" : removed.stderr.trim();
        }
      }
      const own = store.getTask(taskOf(input));
      if (own !== undefined) store.upsertTask({ ...own, state: "closed", note: `Closed after PR #${merged.number}` });
      return { closed: true, pr: merged.number, ...cleanup };
    },
  });

  defineTool(server, context, {
    name: "queue_set",
    description: "Set Project fields of a queued Issue: Status, Worker (Pirx or Human), Queue Order, Priority. Use it to queue new work for Pirx, reorder it, or hand an item to the operator.",
    input: { repository: repositoryInput, issue: issueInput, status: z.enum(["Todo", "Open", "In Progress", "Done"]).optional(), worker: z.enum(["Pirx", "Human"]).optional(), queueOrder: z.number().int().positive().optional(), priority: z.enum(["P0", "P1", "P2", "P3"]).optional(), workType: z.enum(["Task", "Bug", "Experiment"]).optional(), risk: z.enum(["Low", "Medium", "High", "Prod-sensitive"]).optional() },
    mutating: true,
    task: taskOf,
    run: async (input, { run }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const url = `https://github.com/${input.repository}/issues/${input.issue}`;
      if (input.worker === "Pirx") {
        // Worker=Human is the operator's decision (e.g. a paused task). Pirx may queue new items, not take back the operator's.
        const listed = jsonOf(await run("gh", ["project", "item-list", String(settings.projectNumber), "--owner", settings.projectOwner!, "--format", "json", "--limit", "500"], { timeoutMs: 60_000 })) as { items?: Record<string, unknown>[] } | undefined;
        const current = listed?.items?.find((entry) => (entry.content as { url?: string } | undefined)?.url === url);
        if (current?.worker !== "Pirx" && settings.tick !== undefined) {
          // In a tick nobody asked: Pirx may queue only the production bugs it filed. In the chat the operator asks, so anything may be queued.
          const labels = jsonOf(await run("gh", ["issue", "view", String(input.issue), "-R", input.repository, "--json", "labels"])) as { labels?: { name: string }[] } | undefined;
          if (labels?.labels?.some((label) => label.name === BUG_LABEL) !== true) return refuse(`In a tick Pirx queues only ${BUG_LABEL} Issues. ${input.repository}#${input.issue} is not one; the operator decides whether it is queued.`);
        }
        if (current?.worker === "Human") return refuse(`${input.repository}#${input.issue} has Worker=Human: the operator handed it to themselves. Pirx may not take it back; ask the operator if it should be Pirx's.`);
      }
      const found = await projectIds(run, settings);
      if (typeof found.projectId !== "string") return found as Record<string, unknown>;
      const ids = found as { projectId: string; fields: Record<string, { id: string; options: Record<string, string> }> };
      const added = jsonOf(await run("gh", ["project", "item-add", String(settings.projectNumber), "--owner", settings.projectOwner!, "--url", url, "--format", "json"])) as { id?: string } | undefined;
      if (added?.id === undefined) return { error: `Could not add or find ${url} on the Project.` };
      const set: Record<string, unknown> = {};
      const select: [string, string | undefined][] = [["Status", input.status], ["Worker", input.worker], ["Priority", input.priority], ["Work Type", input.workType], ["Risk", input.risk]];
      for (const [name, value] of select) {
        if (value === undefined) continue;
        const field = ids.fields[name]; const option = field?.options[value];
        if (field === undefined || option === undefined) { set[name] = `unknown field or option ${value}`; continue; }
        const edited = await run("gh", ["project", "item-edit", "--id", added.id, "--project-id", ids.projectId, "--field-id", field.id, "--single-select-option-id", option]);
        set[name] = edited.ok ? value : edited.stderr.trim();
      }
      if (input.queueOrder !== undefined) {
        const field = ids.fields["Queue Order"];
        const edited = field === undefined ? undefined : await run("gh", ["project", "item-edit", "--id", added.id, "--project-id", ids.projectId, "--field-id", field.id, "--number", String(input.queueOrder)]);
        set["Queue Order"] = edited?.ok === true ? input.queueOrder : edited?.stderr.trim() ?? "no Queue Order field";
      }
      return { item: added.id, set };
    },
  });

  defineTool(server, context, {
    name: "issue_create",
    description: "Create an Issue in an allowlisted repository. kind=bug: a real production error or a bug the operator reported (label pirx-bug; refused when an open pirx-bug Issue has the same title; Pirx may queue it with queue_set). kind=improvement: tests, cleanups, ideas (label pirx-round; only one may be open, and the operator queues it). Write it for the worker: ## Goal, ## Implementation scope, ## Acceptance criteria with checkboxes. Check issue_list and pr_list first, so it is not a duplicate.",
    input: { repository: repositoryInput, title: z.string().min(1), body: z.string().min(1), errorKey: z.string().optional().describe("For a production bug: source|operation|message as zdrovena_production_errors shows it. Used to spot the same error filed before."), kind: z.enum(["bug", "improvement"]).describe("bug: a real error in production or reported by a user. improvement: tests, cleanups, ideas."), labels: z.array(z.string()).optional() },
    mutating: true,
    run: async (input, { run }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      if (input.kind === "bug") {
        const bugs = jsonOf(await run("gh", ["issue", "list", "-R", input.repository, "--label", BUG_LABEL, "--state", "open", "--json", "number,title,body"])) as { number: number; title: string; body?: string }[] | undefined;
        if (bugs === undefined) return refuse(`Cannot check for open ${BUG_LABEL} Issues, so no new Issue is created.`);
        const fingerprint = bugFingerprint(input.errorKey ?? input.title);
        const same = bugs.find((issue) => (issue.body ?? "").includes(`pirx-bug-fingerprint: ${fingerprint}`) || bugFingerprint(issue.title) === bugFingerprint(input.title));
        if (same !== undefined) return refuse(`This bug is already filed as #${same.number}.`, { open: bugs.map((issue) => ({ number: issue.number, title: issue.title })) });
        if (bugs.length >= MAX_OPEN_BUGS) return refuse(`${bugs.length} Pirx bug Issues are already open; the cap is ${MAX_OPEN_BUGS}. Work on those first.`, { open: bugs });
        const bugArgs = ["issue", "create", "-R", input.repository, "--title", input.title, "--body", `${input.body}\n\n<!-- pirx-bug-fingerprint: ${fingerprint} -->`, "--label", BUG_LABEL];
        for (const label of input.labels ?? []) if (label !== BUG_LABEL && label !== PROPOSAL_LABEL) bugArgs.push("--label", label);
        const filed = await run("gh", bugArgs);
        return filed.ok ? { created: filed.stdout.trim(), issue: Number(/\/issues\/(\d+)/u.exec(filed.stdout)?.[1]), kind: "bug", note: "Queue it with queue_set (worker Pirx) if it should be fixed now." } : failure(filed, "A missing label must be created first, or leave it out.");
      }
      // One open Pirx proposal at a time: prompt rules did not hold this (evals 2026-11-20, open-round-issue).
      const open = jsonOf(await run("gh", ["issue", "list", "-R", input.repository, "--label", PROPOSAL_LABEL, "--state", "open", "--json", "number,title"])) as { number: number; title: string }[] | undefined;
      if (open === undefined) return refuse(`Cannot check for open ${PROPOSAL_LABEL} Issues, so no new Issue is created.`);
      if (open.length > 0) return refuse(`An earlier Pirx proposal is still open (${open.map((issue) => `#${issue.number}`).join(", ")}). Pirx creates a new Issue only when none is open.`, { open });
      const args = ["issue", "create", "-R", input.repository, "--title", input.title, "--body", input.body, "--label", PROPOSAL_LABEL];
      for (const label of input.labels ?? []) if (label !== PROPOSAL_LABEL) args.push("--label", label);
      const result = await run("gh", args);
      return result.ok ? { created: result.stdout.trim(), issue: Number(/\/issues\/(\d+)/u.exec(result.stdout)?.[1]) } : failure(result, "A missing label must be created first, or leave it out.");
    },
  });

  defineTool(server, context, {
    name: "issue_comment",
    description: "Comment on an Issue of an allowlisted repository, e.g. to record what Pirx found or decided.",
    input: { repository: repositoryInput, issue: issueInput, body: z.string().min(1) },
    mutating: true,
    task: taskOf,
    run: async (input, { run }) => {
      const repo = repositoryOrRefusal(settings, input.repository); if (isRefusal(repo)) return repo;
      const result = await run("gh", ["issue", "comment", String(input.issue), "-R", input.repository, "--body", input.body]);
      return result.ok ? { commented: result.stdout.trim() } : failure(result);
    },
  });

  defineTool(server, context, {
    name: "ask_opus",
    description: "Ask Opus for a second opinion when Pirx cannot resolve an anomaly. Send the facts and Pirx's own view; Opus answers with advice only (it has no tools). Pirx still decides. Capped per Task per day.",
    input: { repository: repositoryInput, issue: issueInput, facts: z.string().min(1), question: z.string().min(1), pirxView: z.string().min(1) },
    mutating: false,
    task: taskOf,
    run: async (input, { run, store, environment }) => {
      const task = taskOf(input);
      const used = store.countCalls("ask_opus", startOfDay(store.now()), { task });
      if (used >= settings.caps.askOpusPerTaskPerDay) return refuse(`Opus was asked ${used} times today about ${task}; the cap is ${settings.caps.askOpusPerTaskPerDay}. Ask the operator.`);
      const prompt = `You advise Pirx, a local model that coordinates software delivery for ${input.repository}. Pirx will decide and act; you only advise. Answer in at most 12 lines: what is going on, what Pirx should do next (one of its tools if possible), and what would make you change your mind.\n\nTask: ${task}\n\nFacts:\n${input.facts}\n\nPirx's view:\n${input.pirxView}\n\nQuestion:\n${input.question}`;
      const env: Record<string, string> = {};
      for (const name of WORKER_ENV_ALLOWLIST) { const value = environment[name]; if (value !== undefined) env[name] = value; }
      const result = await run(settings.claudeExecutable, ["-p", "--tools", "", "--disallowedTools", "mcp__*", "--permission-mode", "dontAsk", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--model", settings.opusModel, prompt], { timeoutMs: 5 * 60 * 1000, env });
      const value = jsonOf(result) as { result?: string; is_error?: boolean } | undefined;
      if (value?.result === undefined) return failure(result);
      return { advice: value.result, ...(value.is_error === true ? { error: "Opus reported an error." } : {}) };
    },
  });

  defineTool(server, context, {
    name: "ask_operator",
    description: "Ask the operator a question Pirx and Opus could not settle. It goes to the journal and the chat shows it; the operator answers in the chat. Meanwhile park the Task or do other work.",
    input: { question: z.string().min(1), repository: repositoryInput.optional(), issue: issueInput.optional() },
    mutating: false,
    local: true,
    task: (input) => input.repository !== undefined && input.issue !== undefined ? taskKey(input.repository, input.issue) : undefined,
    run: async (input, { store }) => {
      const task = input.repository !== undefined && input.issue !== undefined ? taskKey(input.repository, input.issue) : undefined;
      const entry = store.append({ ...(settings.tick === undefined ? {} : { tick: settings.tick }), ...(task === undefined ? {} : { task }), kind: "question", name: "ask_operator", input: { question: input.question }, ok: true });
      return { asked: true, seq: entry.seq, note: "The operator sees it in the chat. Do not wait in this tick." };
    },
  });
}
