import { createHash, createHmac } from "node:crypto";

export const HOST_AUTHORIZATION_META_KEY = "pirx.hostAuthorization";

export interface HostToolAuthorization {
  readonly version: 1;
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
): HostToolAuthorization {
  const target = toolTarget(toolName, arguments_);
  const hash = argumentsHash(arguments_);
  const payload = [toolName, target, hash, operationId].join("\u0000");
  return {
    version: 1,
    toolName,
    target,
    argumentsHash: hash,
    operationId,
    idempotencyKey: operationId,
    signature: createHmac("sha256", secret).update(payload).digest("base64url"),
  };
}
