import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { backlinks, outgoingLinks } from "../obsidian/graph.js";
import { normalizeNotePath, type ObsidianVault } from "../obsidian/vaults.js";

const notePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .describe("Vault-relative Markdown note path ending in .md");
const noteContentSchema = z.string().max(2_000_000);
const pathResultSchema = z.object({ path: z.string() });
const noteResultSchema = z.object({ path: z.string(), content: z.string() });
const pathsResultSchema = z.object({ paths: z.array(z.string()) });

function configuredVault(vault: ObsidianVault | undefined): ObsidianVault {
  if (vault === undefined) {
    throw new Error(
      "Obsidian is not configured. Set PIRX_OBSIDIAN_VAULT to a vault directory.",
    );
  }
  return vault;
}

function structured(result: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export function registerObsidianTools(
  server: McpServer,
  vault: ObsidianVault | undefined,
): void {
  server.registerTool(
    "obsidian_read",
    {
      title: "Read an Obsidian note",
      description:
        "Read the current contents of one Markdown note. Use this again whenever the user asks to confirm the note's current external state.",
      inputSchema: z.object({ path: notePathSchema }),
      outputSchema: noteResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const result = { path: normalizeNotePath(path), content: await configuredVault(vault).read(path) };
      return structured(result);
    },
  );

  server.registerTool(
    "obsidian_create",
    {
      title: "Create an Obsidian note",
      description:
        "Create a new Markdown note. This never overwrites an existing note.",
      inputSchema: z.object({ path: notePathSchema, content: noteContentSchema }),
      outputSchema: pathResultSchema.extend({ created: z.literal(true) }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, content }) => {
      await configuredVault(vault).create(path, content);
      return structured({ path: normalizeNotePath(path), created: true });
    },
  );

  server.registerTool(
    "obsidian_write",
    {
      title: "Overwrite an Obsidian note",
      description:
        "Replace the contents of an existing Markdown note. This fails if the note does not exist.",
      inputSchema: z.object({ path: notePathSchema, content: noteContentSchema }),
      outputSchema: pathResultSchema.extend({ written: z.literal(true) }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, content }) => {
      await configuredVault(vault).write(path, content);
      return structured({ path: normalizeNotePath(path), written: true });
    },
  );

  server.registerTool(
    "obsidian_append",
    {
      title: "Append to an Obsidian note",
      description:
        "Append text to an existing Markdown note with a safe line boundary. This fails if the note does not exist.",
      inputSchema: z.object({
        path: notePathSchema,
        content: noteContentSchema.min(1),
      }),
      outputSchema: pathResultSchema.extend({ appended: z.literal(true) }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, content }) => {
      await configuredVault(vault).append(path, content);
      return structured({ path: normalizeNotePath(path), appended: true });
    },
  );

  server.registerTool(
    "obsidian_search",
    {
      title: "Search Obsidian notes",
      description: "Search Markdown note names and contents in the configured vault.",
      inputSchema: z.object({ query: z.string().trim().min(1).max(500) }),
      outputSchema: pathsResultSchema.extend({ query: z.string() }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => structured({ query, paths: await configuredVault(vault).search(query) }),
  );

  server.registerTool(
    "obsidian_list",
    {
      title: "List Obsidian notes",
      description:
        "List current Markdown notes, optionally below a vault-relative directory.",
      inputSchema: z.object({
        directory: z.string().trim().max(1_024).optional(),
      }),
      outputSchema: pathsResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ directory }) =>
      structured({ paths: await configuredVault(vault).list(directory ?? "") }),
  );

  server.registerTool(
    "obsidian_move",
    {
      title: "Move an Obsidian note",
      description:
        "Move an existing Markdown note to a new vault-relative path without overwriting the destination.",
      inputSchema: z.object({
        source: notePathSchema,
        destination: notePathSchema,
      }),
      outputSchema: z.object({
        source: z.string(),
        destination: z.string(),
        moved: z.literal(true),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ source, destination }) => {
      await configuredVault(vault).move(source, destination);
      return structured({
        source: normalizeNotePath(source),
        destination: normalizeNotePath(destination),
        moved: true,
      });
    },
  );

  server.registerTool(
    "obsidian_delete",
    {
      title: "Delete an Obsidian note",
      description: "Delete exactly one existing Markdown note inside the configured vault.",
      inputSchema: z.object({ path: notePathSchema }),
      outputSchema: pathResultSchema.extend({ deleted: z.literal(true) }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      await configuredVault(vault).delete(path);
      return structured({ path: normalizeNotePath(path), deleted: true });
    },
  );

  server.registerTool(
    "obsidian_add_link",
    {
      title: "Add an Obsidian wikilink",
      description:
        "Append a native Obsidian wikilink to an existing note. Repeating the same target does not add a duplicate.",
      inputSchema: z.object({
        path: notePathSchema,
        target: notePathSchema,
        alias: z.string().trim().min(1).max(300).optional(),
        heading: z.string().trim().min(1).max(300).optional(),
      }),
      outputSchema: z.object({
        path: z.string(),
        target: z.string(),
        link: z.string(),
        added: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, target, alias, heading }) => {
      const options = {
        ...(alias !== undefined ? { alias } : {}),
        ...(heading !== undefined ? { heading } : {}),
      };
      const result = await configuredVault(vault).addLink(path, target, options);
      return structured({
        path: normalizeNotePath(path),
        target: normalizeNotePath(target),
        ...result,
      });
    },
  );

  server.registerTool(
    "obsidian_links",
    {
      title: "List outgoing Obsidian links",
      description: "Return unique outgoing wikilink targets from one Markdown note.",
      inputSchema: z.object({ path: notePathSchema }),
      outputSchema: z.object({ path: z.string(), links: z.array(z.string()) }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) =>
      structured({
        path: normalizeNotePath(path),
        links: await outgoingLinks(configuredVault(vault), path),
      }),
  );

  server.registerTool(
    "obsidian_backlinks",
    {
      title: "List Obsidian backlinks",
      description:
        "Scan the vault and return Markdown notes that currently link to the target note.",
      inputSchema: z.object({ path: notePathSchema }),
      outputSchema: z.object({ path: z.string(), backlinks: z.array(z.string()) }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) =>
      structured({
        path: normalizeNotePath(path),
        backlinks: await backlinks(configuredVault(vault), path),
      }),
  );
}
