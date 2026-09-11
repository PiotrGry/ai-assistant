import { GitHubIssueLifecycleRoundTrip } from "./issue-round-trip.js";
import { GitHubIssueMutator } from "./issue-mutate.js";
import { GitHubIssueReader } from "./issue-read.js";
import { GitHubTransport } from "./transport.js";
import { GitHubWriteQueue } from "./write-queue.js";
import { loadGitHubConfig } from "./config.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Missing opt-in round-trip configuration: ${name}.`);
  return value;
}

function issueNumber(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("PIRX_GITHUB_ROUND_TRIP_ISSUE must be a positive integer.");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("PIRX_GITHUB_ROUND_TRIP_ISSUE must be a positive integer.");
  return number;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

async function main(): Promise<void> {
  const config = loadGitHubConfig();
  const issue = issueNumber(required(process.env, "PIRX_GITHUB_ROUND_TRIP_ISSUE"));
  const eventId = required(process.env, "PIRX_GITHUB_ROUND_TRIP_EVENT_ID");
  const transport = new GitHubTransport(config);
  const reader = new GitHubIssueReader(transport, config);
  const queue = new GitHubWriteQueue();
  const mutator = new GitHubIssueMutator(transport, reader, queue, config);
  const roundTrip = new GitHubIssueLifecycleRoundTrip(reader, mutator);
  try {
    const attemptId = optional(process.env, "PIRX_GITHUB_ROUND_TRIP_ATTEMPT_ID");
    const branch = optional(process.env, "PIRX_GITHUB_ROUND_TRIP_BRANCH");
    const commit = optional(process.env, "PIRX_GITHUB_ROUND_TRIP_COMMIT");
    const idempotencyKey = optional(process.env, "PIRX_GITHUB_ROUND_TRIP_IDEMPOTENCY_KEY");
    const result = await roundTrip.execute({
      issue,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      lifecycle: {
        eventId,
        eventType: optional(process.env, "PIRX_GITHUB_ROUND_TRIP_EVENT_TYPE") ?? "manual.round_trip",
        taskId: optional(process.env, "PIRX_GITHUB_ROUND_TRIP_TASK_ID") ?? "github-round-trip-poc",
        ...(attemptId === undefined ? {} : { attemptId }),
        timestamp: new Date().toISOString(),
        summary: optional(process.env, "PIRX_GITHUB_ROUND_TRIP_SUMMARY") ?? "Controlled Pirx GitHub lifecycle round-trip.",
        ...(branch === undefined ? {} : { branch }),
        ...(commit === undefined ? {} : { commit }),
      },
      replay: true,
    });
    console.log(JSON.stringify(result));
    if (result.outcome !== "success") process.exitCode = 1;
  } finally {
    await queue.close({ drain: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Round-trip failed.";
  console.error(`GitHub round-trip failed: ${message}`);
  process.exitCode = 1;
});
