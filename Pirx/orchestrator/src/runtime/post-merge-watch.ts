import type { GitHubActionsWorkflowRun } from "../github/ci-watch.js";
import type { GitHubOperationResult } from "../github/outcome.js";
import type { UtcTimestamp } from "./task-domain.js";

/**
 * A repository that releases on its own (auto-merge, release PR, deploy) ends a Task at
 * the merge into its base branch. Pirx still watches that pipeline for the merged change,
 * so a failure goes back to a worker instead of passing unseen.
 */
export interface PostMergeCheck {
  /** Workflow file name, e.g. "release-validation.yml". */
  readonly workflow: string;
  readonly branch: string;
  /** A workflow the repository may skip for this change (a deploy after a docs-only change). */
  readonly optional?: boolean;
}

export interface PostMergePolicy {
  readonly checks: readonly PostMergeCheck[];
  /** Branches the merged change must reach, e.g. the production branch. */
  readonly mustReach: readonly string[];
  readonly optionalGraceMinutes: number;
  readonly timeoutMinutes: number;
}

export interface PostMergeGateway {
  /** Newest first. */
  listWorkflowRuns(workflow: string, branch: string): Promise<GitHubOperationResult<readonly GitHubActionsWorkflowRun[]>>;
  /** True when `head` is `ancestor` or a descendant of it. */
  contains(ancestor: string, head: string): Promise<GitHubOperationResult<boolean>>;
  branchHead(branch: string): Promise<GitHubOperationResult<string>>;
}

export type PostMergeOutcome = "passed" | "waiting" | "failed" | "timed_out" | "unavailable";

export interface PostMergeResult {
  readonly outcome: PostMergeOutcome;
  readonly message: string;
  readonly failedRun?: GitHubActionsWorkflowRun;
  /** Workflow runs that passed for the merged change. */
  readonly passedRunIds: readonly number[];
}

export interface PostMergeRequest {
  readonly policy: PostMergePolicy;
  readonly mergeSha: string;
  readonly mergedAt: UtcTimestamp;
  readonly now: UtcTimestamp;
  readonly gateway: PostMergeGateway;
}

class Unavailable extends Error {}

export async function watchPostMerge(request: PostMergeRequest): Promise<PostMergeResult> {
  const { policy, mergeSha, gateway } = request;
  const known = new Map<string, boolean>([[mergeSha, true]]);
  const contains = async (head: string): Promise<boolean> => {
    const cached = known.get(head); if (cached !== undefined) return cached;
    const value = await gateway.contains(mergeSha, head);
    if (value.outcome !== "success") throw new Unavailable(`Comparing ${mergeSha.slice(0, 7)} with ${head.slice(0, 7)} failed: ${value.error.message}`);
    known.set(head, value.value); return value.value;
  };
  const short = mergeSha.slice(0, 7);
  try {
    const unreached: string[] = [];
    for (const branch of policy.mustReach) {
      const head = await gateway.branchHead(branch);
      if (head.outcome !== "success") throw new Unavailable(`Reading ${branch} failed: ${head.error.message}`);
      if (!(await contains(head.value))) unreached.push(branch);
    }
    const passed: number[] = []; const pending: string[] = []; const skippable: string[] = []; let lastRequiredDone = Date.parse(request.mergedAt);
    for (const check of policy.checks) {
      const runs = await gateway.listWorkflowRuns(check.workflow, check.branch);
      if (runs.outcome !== "success") throw new Unavailable(`Listing ${check.workflow} runs on ${check.branch} failed: ${runs.error.message}`);
      // A branch only moves forward, so the runs that contain the merge are the newest ones: walk back until one does not.
      let earliest: GitHubActionsWorkflowRun | undefined;
      for (const run of runs.value) { if (!(await contains(run.headSha))) break; earliest = run; }
      const name = `${check.workflow} on ${check.branch}`;
      if (earliest === undefined) { (check.optional === true ? skippable : pending).push(name); continue; }
      if (earliest.status !== "completed") { pending.push(`${name} (run ${earliest.id} ${earliest.status})`); continue; }
      if (earliest.conclusion !== "success") return { outcome: "failed", message: `${name} failed for ${short}: run ${earliest.id} ended ${earliest.conclusion ?? "without a conclusion"} (${earliest.url}).`, failedRun: earliest, passedRunIds: passed };
      passed.push(earliest.id);
      if (check.optional !== true) lastRequiredDone = Math.max(lastRequiredDone, Date.parse(earliest.updatedAt ?? request.now));
    }
    const graceEnds = lastRequiredDone + policy.optionalGraceMinutes * 60_000;
    const settled = pending.length === 0 && unreached.length === 0;
    if (settled && (skippable.length === 0 || Date.parse(request.now) >= graceEnds)) {
      return { outcome: "passed", message: `The pipeline passed for ${short}${skippable.length === 0 ? "" : `; not run for this change: ${skippable.join(", ")}`}.`, passedRunIds: passed };
    }
    const waitingFor = [...pending, ...unreached.map((branch) => `${short} to reach ${branch}`), ...(settled ? skippable.map((name) => `${name} (optional)`) : [])];
    if (Date.parse(request.now) - Date.parse(request.mergedAt) > policy.timeoutMinutes * 60_000) return { outcome: "timed_out", message: `The pipeline for ${short} did not finish within ${policy.timeoutMinutes} minutes; still waiting for ${waitingFor.join(", ")}.`, passedRunIds: passed };
    return { outcome: "waiting", message: `Waiting for ${waitingFor.join(", ")}.`, passedRunIds: passed };
  } catch (error: unknown) {
    if (error instanceof Unavailable) return { outcome: "unavailable", message: error.message, passedRunIds: [] };
    throw error;
  }
}
