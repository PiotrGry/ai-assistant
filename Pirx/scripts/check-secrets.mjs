import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pirxRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(pirxRoot, "..");
const tracked = execFileSync("git", ["-C", repositoryRoot, "ls-files", "-z", "--", "Pirx"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean);
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/u],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u],
  ["Stripe live key", /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/u],
];
const findings = [];
for (const relative of tracked) {
  const filename = resolve(repositoryRoot, relative);
  let stat;
  try { stat = statSync(filename); } catch { continue; }
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
  const content = readFileSync(filename);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [name, pattern] of rules) if (pattern.test(text)) findings.push(`${relative}: ${name}`);
}
if (findings.length > 0) {
  process.stderr.write(`High-confidence credential material found:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${tracked.length} tracked Pirx files; no high-confidence credential material found.\n`);
}
