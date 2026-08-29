import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";

export class ObsidianVault {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #resolvePath(path: string): string {
    const resolved = resolve(this.#root, path);
    const rel = relative(this.#root, resolved);

    if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
      throw new Error("Path outside Obsidian vault");
    }

    return resolved;
  }

  async read(path: string): Promise<string> {
    return readFile(this.#resolvePath(path), "utf8");
  }

  async create(path: string, content: string): Promise<void> {
    const target = this.#resolvePath(path);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  async append(path: string, content: string): Promise<void> {
    const target = this.#resolvePath(path);

    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, content, "utf8");
  }

  async search(query: string): Promise<string[]> {
    const results: string[] = [];

    await this.#searchDirectory(this.#root, query.toLowerCase(), results);

    return results;
  }

  async #searchDirectory(
    directory: string,
    query: string,
    results: string[],
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        await this.#searchDirectory(fullPath, query, results);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const content = await readFile(fullPath, "utf8");

      if (
        entry.name.toLowerCase().includes(query) ||
        content.toLowerCase().includes(query)
      ) {
        results.push(relative(this.#root, fullPath));
      }
    }
  }
}

