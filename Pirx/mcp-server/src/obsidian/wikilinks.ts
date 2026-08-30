import { basename, posix } from "node:path";

export interface Wikilink {
  readonly target: string;
  readonly alias?: string;
  readonly heading?: string;
}

function cleanTarget(target: string): string {
  return target
    .trim()
    .replace(/^\.\//u, "")
    .replace(/\.md$/iu, "");
}

function targetKey(target: string): string {
  return cleanTarget(target).toLowerCase();
}

export function parseWikilinks(markdown: string): Wikilink[] {
  const links: Wikilink[] = [];
  const seen = new Set<string>();
  const expression = /\[\[([^\]\r\n]+)\]\]/gu;

  for (const match of markdown.matchAll(expression)) {
    const body = match[1];
    if (body === undefined) {
      continue;
    }

    const aliasSeparator = body.indexOf("|");
    const destination = (aliasSeparator === -1 ? body : body.slice(0, aliasSeparator)).trim();
    const rawAlias = aliasSeparator === -1 ? undefined : body.slice(aliasSeparator + 1).trim();
    const headingSeparator = destination.indexOf("#");
    const target = cleanTarget(
      headingSeparator === -1 ? destination : destination.slice(0, headingSeparator),
    );
    const rawHeading =
      headingSeparator === -1 ? undefined : destination.slice(headingSeparator + 1).trim();

    if (target.length === 0) {
      continue;
    }

    const key = targetKey(target);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    links.push({
      target,
      ...(rawAlias !== undefined && rawAlias.length > 0 ? { alias: rawAlias } : {}),
      ...(rawHeading !== undefined && rawHeading.length > 0
        ? { heading: rawHeading }
        : {}),
    });
  }

  return links;
}

function assertLinkPart(name: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\]\r\n|]/u.test(trimmed)) {
    throw new Error(`${name} contains characters that are unsafe in an Obsidian wikilink.`);
  }
  return trimmed;
}

export function buildWikilink(
  markdownPath: string,
  options: { readonly alias?: string; readonly heading?: string } = {},
): string {
  let destination = cleanTarget(markdownPath);
  if (options.heading !== undefined) {
    destination += `#${assertLinkPart("heading", options.heading)}`;
  }
  if (options.alias !== undefined) {
    destination += `|${assertLinkPart("alias", options.alias)}`;
  }
  return `[[${destination}]]`;
}

export function matchesWikilinkTarget(linkTarget: string, markdownPath: string): boolean {
  const link = targetKey(linkTarget);
  const note = targetKey(markdownPath);

  if (link.includes("/")) {
    return link === note;
  }

  return link === basename(note);
}

export function wikilinkTargets(markdown: string): string[] {
  return parseWikilinks(markdown).map((link) => posix.normalize(link.target));
}
