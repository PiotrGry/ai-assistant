import { normalizeNotePath, type ObsidianVault } from "./vaults.js";
import { matchesWikilinkTarget, wikilinkTargets } from "./wikilinks.js";

export async function outgoingLinks(
  vault: ObsidianVault,
  path: string,
): Promise<string[]> {
  return wikilinkTargets(await vault.read(path));
}

export async function backlinks(
  vault: ObsidianVault,
  targetPath: string,
): Promise<string[]> {
  const normalizedTarget = normalizeNotePath(targetPath);
  const results: string[] = [];
  for (const candidate of await vault.list()) {
    const links = wikilinkTargets(await vault.read(candidate));
    if (links.some((link) => matchesWikilinkTarget(link, normalizedTarget))) {
      results.push(candidate);
    }
  }
  return results;
}
