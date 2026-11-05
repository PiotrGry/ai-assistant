import { timingSafeEqual, createHash, createHmac } from "node:crypto";
import * as z from "zod/v4";

export const HOST_AUTHORIZATION_META_KEY = "pirx.hostAuthorization";

export interface HostToolAuthorization {
  readonly version: 2;
  readonly toolName: string;
  readonly target: string;
  readonly argumentsHash: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly signature: string;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

export function argumentsHash(arguments_: Record<string, unknown>): string {
  return createHash("sha256").update(stableSerialize(arguments_)).digest("hex");
}

export function toolTarget(name: string, arguments_: Record<string, unknown>): string {
  const identifiers = ["path", "source", "destination", "calendarId", "eventId", "issueNumber"]
    .filter((key) => typeof arguments_[key] === "string" || typeof arguments_[key] === "number")
    .map((key) => `${key}=${String(arguments_[key])}`);
  return [name, ...identifiers].join(" ");
}

export function createHostAuthorization(
  secret: string,
  toolName: string,
  arguments_: Record<string, unknown>,
  operationId: string,
  idempotencyKey: string = operationId,
): HostToolAuthorization {
  const target = toolTarget(toolName, arguments_);
  const hash = argumentsHash(arguments_);
  const payload = [toolName, target, hash, operationId, idempotencyKey].join("\u0000");
  return {
    version: 2,
    toolName,
    target,
    argumentsHash: hash,
    operationId,
    idempotencyKey,
    signature: createHmac("sha256", secret).update(payload).digest("base64url"),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validAuthorization(value: unknown): value is HostToolAuthorization {
  const item = record(value);
  return item?.version === 2 &&
    stringValue(item.toolName) !== undefined &&
    stringValue(item.target) !== undefined &&
    stringValue(item.argumentsHash) !== undefined &&
    stringValue(item.operationId) !== undefined &&
    stringValue(item.idempotencyKey) !== undefined &&
    stringValue(item.signature) !== undefined;
}

export function verifyHostAuthorization(
  secret: string | undefined,
  meta: unknown,
  toolName: string,
  arguments_: Record<string, unknown>,
): HostToolAuthorization | undefined {
  if (secret === undefined || secret.length === 0) return undefined;
  const metadata = record(meta);
  const authorization = metadata?.[HOST_AUTHORIZATION_META_KEY];
  if (!validAuthorization(authorization)) return undefined;
  if (authorization.toolName !== toolName || authorization.target !== toolTarget(toolName, arguments_) || authorization.argumentsHash !== argumentsHash(arguments_)) return undefined;
  const payload = [authorization.toolName, authorization.target, authorization.argumentsHash, authorization.operationId, authorization.idempotencyKey].join("\u0000");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const actual = Buffer.from(authorization.signature);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted) ? authorization : undefined;
}

export const authorizationFailureSchema = z.object({
  outcome: z.enum(["authorization_required", "authorization_replayed"]),
  remoteOutcome: z.literal("not_accepted"),
  message: z.string(),
});

export type HostAuthorizationDecision =
  | { readonly ok: true; readonly authorization: HostToolAuthorization }
  | { readonly ok: false; readonly failure: z.infer<typeof authorizationFailureSchema> };

/**
 * Process-scoped replay guard. The durable action ledger remains owned by the
 * host; this guard prevents one signed dispatch from producing two effects in
 * the same MCP process. The production host rotates the secret for every child
 * connection, so authorizations captured from an earlier child cannot be
 * accepted after reconnect. The durable action ledger remains responsible for
 * deciding whether a fresh operation may be dispatched.
 */
export class SingleUseHostAuthorization {
  readonly #secret: string | undefined;
  readonly #consumed = new Set<string>();

  constructor(secret: string | undefined) {
    this.#secret = secret;
  }

  consume(meta: unknown, toolName: string, arguments_: Record<string, unknown>): HostAuthorizationDecision {
    const authorization = verifyHostAuthorization(this.#secret, meta, toolName, arguments_);
    if (authorization === undefined) {
      return { ok: false, failure: { outcome: "authorization_required", remoteOutcome: "not_accepted", message: "Exact Pirx host authorization is required for this tool and argument set." } };
    }
    if (this.#consumed.has(authorization.operationId)) {
      return { ok: false, failure: { outcome: "authorization_replayed", remoteOutcome: "not_accepted", message: "This host authorization was already consumed and cannot be used again." } };
    }
    this.#consumed.add(authorization.operationId);
    return { ok: true, authorization };
  }
}

export function rejectedAuthorization(failure: z.infer<typeof authorizationFailureSchema>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(failure) }],
    structuredContent: failure,
    isError: true,
  };
}
