import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { randomUUID } from "node:crypto";

import {
  buildWikilink,
  matchesWikilinkTarget,
  parseWikilinks,
} from "./wikilinks.js";

export type ObsidianErrorCode =
  | "invalid_path"
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "not_a_note"
  | "io_error";

export class ObsidianError extends Error {
  readonly code: ObsidianErrorCode;

  constructor(code: ObsidianErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObsidianError";
    this.code = code;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function controlledIoError(action: string, path: string, error: unknown): ObsidianError {
  if (error instanceof ObsidianError) {
    return error;
  }

  const code = errorCode(error);
  if (code === "ENOENT") {
    return new ObsidianError("not_found", `Obsidian note not found: ${path}`, {
      cause: error,
    });
  }
  if (code === "EEXIST") {
    return new ObsidianError("already_exists", `Obsidian note already exists: ${path}`, {
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ObsidianError(
      "permission_denied",
      `Permission denied while trying to ${action} Obsidian note: ${path}`,
      { cause: error },
    );
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new ObsidianError(
    "io_error",
    `Could not ${action} Obsidian note ${path}: ${detail}`,
    { cause: error },
  );
}

function pathSegments(path: string): string[] {
  return path.split("/");
}

function assertSafeSegments(path: string, allowEmpty: boolean): string[] {
  if (path.includes("\0")) {
    throw new ObsidianError("invalid_path", "Obsidian path contains a null byte.");
  }
  if (path.includes("\\")) {
    throw new ObsidianError(
      "invalid_path",
      "Obsidian paths must use forward slashes.",
    );
  }
  if (isAbsolute(path) || win32.isAbsolute(path)) {
    throw new ObsidianError(
      "invalid_path",
      "Absolute Obsidian paths are not allowed.",
    );
  }

  const trimmed = path.trim();
  if (trimmed.length === 0) {
    if (allowEmpty) {
      return [];
    }
    throw new ObsidianError("invalid_path", "Obsidian note path cannot be empty.");
  }

  const segments = pathSegments(trimmed);
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    throw new ObsidianError(
      "invalid_path",
      "Obsidian paths cannot contain traversal, empty, or hidden segments.",
    );
  }

  return segments;
}

export function normalizeNotePath(path: string): string {
  const segments = assertSafeSegments(path, false);
  const normalized = segments.join("/");

  if (extname(normalized).toLowerCase() !== ".md") {
    throw new ObsidianError(
      "not_a_note",
      `Only Markdown notes with a .md extension are allowed: ${path}`,
    );
  }

  return normalized;
}

function normalizeDirectoryPath(path: string): string {
  return assertSafeSegments(path, true).join("/");
}

function portableRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function assertWithinVault(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return;
  }

  throw new ObsidianError("invalid_path", "Path outside Obsidian vault.");
}

export class ObsidianVault {
  readonly #root: string;
  #appendMutation: Promise<void> = Promise.resolve();
  #linkMutation: Promise<void> = Promise.resolve();

  constructor(root: string) {
    if (root.trim().length === 0) {
      throw new ObsidianError("invalid_path", "Obsidian vault path cannot be empty.");
    }
    this.#root = resolve(root);
  }

  async #realRoot(): Promise<string> {
    try {
      const root = await realpath(this.#root);
      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) {
        throw new ObsidianError(
          "invalid_path",
          `Obsidian vault is not a directory: ${this.#root}`,
        );
      }
      return root;
    } catch (error: unknown) {
      throw controlledIoError("access", this.#root, error);
    }
  }

  async #assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
    let current = root;
    for (const segment of pathSegments(relativePath)) {
      if (segment.length === 0) {
        continue;
      }
      current = join(current, segment);
      let entry;
      try {
        entry = await lstat(current);
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") {
          return;
        }
        throw error;
      }
      if (entry.isSymbolicLink()) {
        throw new ObsidianError(
          "invalid_path",
          `Symbolic links are not allowed in Obsidian note paths: ${relativePath}`,
        );
      }
    }
  }

  async #existingNote(path: string): Promise<{ normalized: string; target: string }> {
    const normalized = normalizeNotePath(path);
    const root = await this.#realRoot();
    const target = resolve(root, normalized);
    assertWithinVault(root, target);

    try {
      await this.#assertNoSymlinkComponents(root, normalized);
      const entry = await lstat(target);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new ObsidianError(
          "not_a_note",
          `Obsidian path is not a regular Markdown note: ${normalized}`,
        );
      }

      const actual = await realpath(target);
      assertWithinVault(root, actual);
      normalizeNotePath(portableRelative(root, actual));
      return { normalized, target: actual };
    } catch (error: unknown) {
      throw controlledIoError("access", normalized, error);
    }
  }

  async #newNote(path: string): Promise<{ normalized: string; target: string }> {
    const normalized = normalizeNotePath(path);
    const root = await this.#realRoot();
    const target = resolve(root, normalized);
    assertWithinVault(root, target);

    try {
      const parentRelative = posix.dirname(normalized);
      await this.#assertNoSymlinkComponents(
        root,
        parentRelative === "." ? "" : parentRelative,
      );
      await mkdir(dirname(target), { recursive: true });
      await this.#assertNoSymlinkComponents(
        root,
        parentRelative === "." ? "" : parentRelative,
      );
      const actualParent = await realpath(dirname(target));
      assertWithinVault(root, actualParent);
      const actualTarget = resolve(actualParent, basename(target));
      assertWithinVault(root, actualTarget);
      return { normalized, target: actualTarget };
    } catch (error: unknown) {
      throw controlledIoError("prepare", normalized, error);
    }
  }

  async read(path: string): Promise<string> {
    const note = await this.#existingNote(path);
    try {
      return await readFile(note.target, "utf8");
    } catch (error: unknown) {
      throw controlledIoError("read", note.normalized, error);
    }
  }

  async create(path: string, content: string): Promise<void> {
    const note = await this.#newNote(path);
    let handle;
    let created = false;
    try {
      handle = await open(
        note.target,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      await handle.writeFile(content, "utf8");
    } catch (error: unknown) {
      if (created) {
        await unlink(note.target).catch(() => undefined);
      }
      throw controlledIoError("create", note.normalized, error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async write(path: string, content: string): Promise<void> {
    const note = await this.#existingNote(path);
    const temporary = join(
      dirname(note.target),
      `.${basename(note.target)}.pirx-${randomUUID()}.tmp`,
    );

    try {
      const currentMode = (await stat(note.target)).mode & 0o777;
      await writeFile(temporary, content, {
        encoding: "utf8",
        flag: "wx",
        mode: currentMode,
      });
      await this.#existingNote(note.normalized);
      await rename(temporary, note.target);
    } catch (error: unknown) {
      throw controlledIoError("write", note.normalized, error);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async append(path: string, content: string): Promise<void> {
    const operation = this.#appendMutation
      .catch(() => undefined)
      .then(async () => {
        const note = await this.#existingNote(path);
        let handle;

        try {
          handle = await open(
            note.target,
            constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
          );
          const opened = await handle.stat();
          if (!opened.isFile()) {
            throw new ObsidianError(
              "not_a_note",
              `Obsidian path is not a regular Markdown note: ${note.normalized}`,
            );
          }
          const existing = await handle.readFile("utf8");
          const separator =
            existing.length > 0 &&
            !existing.endsWith("\n") &&
            content.length > 0 &&
            !content.startsWith("\n")
              ? "\n"
              : "";
          await handle.appendFile(`${separator}${content}`, "utf8");
        } catch (error: unknown) {
          throw controlledIoError("append", note.normalized, error);
        } finally {
          await handle?.close().catch(() => undefined);
        }
      });
    this.#appendMutation = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async list(directory = ""): Promise<string[]> {
    const normalizedDirectory = normalizeDirectoryPath(directory);
    const root = await this.#realRoot();
    const target = resolve(root, normalizedDirectory);
    assertWithinVault(root, target);

    try {
      await this.#assertNoSymlinkComponents(root, normalizedDirectory);
      const actual = await realpath(target);
      assertWithinVault(root, actual);
      const entry = await lstat(actual);
      if (!entry.isDirectory()) {
        throw new ObsidianError(
          "invalid_path",
          `Obsidian list path is not a directory: ${directory}`,
        );
      }

      const results: string[] = [];
      await this.#collectNotes(root, actual, results);
      return results.sort();
    } catch (error: unknown) {
      throw controlledIoError("list", directory || ".", error);
    }
  }

  async #collectNotes(root: string, directory: string, results: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = resolve(directory, entry.name);
      assertWithinVault(root, fullPath);
      if (entry.isDirectory()) {
        await this.#collectNotes(root, fullPath, results);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        results.push(portableRelative(root, fullPath));
      }
    }
  }

  async search(query: string): Promise<string[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      throw new ObsidianError("invalid_path", "Obsidian search query cannot be empty.");
    }

    const results: string[] = [];
    for (const path of await this.list()) {
      const content = await this.read(path);
      if (
        path.toLowerCase().includes(normalizedQuery) ||
        content.toLowerCase().includes(normalizedQuery)
      ) {
        results.push(path);
      }
    }
    return results;
  }

  async move(sourcePath: string, destinationPath: string): Promise<void> {
    const source = await this.#existingNote(sourcePath);
    const destination = await this.#newNote(destinationPath);
    if (source.normalized === destination.normalized) {
      throw new ObsidianError(
        "invalid_path",
        "Obsidian source and destination paths must be different.",
      );
    }

    let destinationCreated = false;
    try {
      await link(source.target, destination.target);
      destinationCreated = true;
      await unlink(source.target);
    } catch (error: unknown) {
      if (destinationCreated) {
        await unlink(destination.target).catch(() => undefined);
      }
      throw controlledIoError("move", `${source.normalized} -> ${destination.normalized}`, error);
    }
  }

  async delete(path: string): Promise<void> {
    const note = await this.#existingNote(path);
    try {
      await unlink(note.target);
    } catch (error: unknown) {
      throw controlledIoError("delete", note.normalized, error);
    }
  }

  async addLink(
    path: string,
    targetPath: string,
    options: { readonly alias?: string; readonly heading?: string } = {},
  ): Promise<{ readonly added: boolean; readonly link: string }> {
    const operation = this.#linkMutation
      .catch(() => undefined)
      .then(async () => {
        const target = normalizeNotePath(targetPath);
        const content = await this.read(path);
        const link = buildWikilink(target, options);
        const duplicate = parseWikilinks(content).some((existing) =>
          matchesWikilinkTarget(existing.target, target),
        );

        if (!duplicate) {
          await this.append(path, link);
        }

        return { added: !duplicate, link };
      });
    this.#linkMutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
