// Shared contract for the MCP Hub plugin.
//
// The host entry owns the file system: it reads the hub configuration files and
// writes the generated artifacts on the machine's home directory. The server
// entry owns the semantics: merging scopes, rendering each harness format and
// deciding what may be overwritten.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** One MCP server as authored in a hub file. */
const hubServerShape = {
  /** Remote servers use a URL, local servers a command. */
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Defaults to true; false removes the server from generated files. */
  enabled: z.boolean().optional(),
};

/**
 * A hub file may carry harness options MCP Hub does not interpret (`timeout`,
 * `oauth`, ...); they are kept and passed through to the generated file.
 */
export const hubServerSchema = z.object(hubServerShape).loose();

export type HubServer = z.infer<typeof hubServerSchema>;

/** What the page may write: harness extras are kept, exactly one transport. */
export const serverDefinitionSchema = z
  .object(hubServerShape)
  .loose()
  .superRefine((value, ctx) => {
    const hasUrl = value.url !== undefined;
    const hasCommand = value.command !== undefined;
    if (hasUrl === hasCommand) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Set exactly one of `url` or `command`.",
      });
    }
  });

export const hubFileSchema = z
  .object({
    servers: z.record(z.string(), hubServerSchema).default({}),
  })
  .loose();

export type HubFile = z.infer<typeof hubFileSchema>;

export const ownedStateSchema = z
  .object({
    files: z
      .record(
        z.string(),
        z.object({
          sha256: z.string(),
          writtenAt: z.number(),
        }),
      )
      .default({}),
  })
  .loose();

export type OwnedState = z.infer<typeof ownedStateSchema>;

export const targetFileSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    /** 0o600 for files that carry secrets. */
    mode: z.number().int().nonnegative().optional(),
  })
  .strict();

export type TargetFile = z.infer<typeof targetFileSchema>;

/** A harness configuration MCP Hub does not own, read to report name clashes. */
export const foreignFileSchema = z
  .object({
    path: z.string(),
    exists: z.boolean(),
    /** Parsed JSON as written by the harness, or null when missing or unreadable. */
    json: z.unknown().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const applyResultSchema = z
  .object({
    path: z.string(),
    status: z.enum(["written", "unchanged", "removed", "foreign", "backed-up"]),
    /** Why a file was not written; null when it was. */
    message: z.string().nullable(),
  })
  .strict();

export type ApplyResult = z.infer<typeof applyResultSchema>;

export const hostContract = defineRpcContract({
  snapshot: {
    input: z
      .object({
        /** Absolute workspace root, or null for host-scope only. */
        projectPath: z.string().nullable(),
        /** Generated target files to stat and hash for ownership. */
        paths: z.array(z.string()),
        /** Harness files to read for name clashes; parsed, never modified. */
        foreignPaths: z.array(z.string()),
      })
      .strict(),
    output: z
      .object({
        home: z.string(),
        host: hubFileSchema.nullable(),
        hostLocal: hubFileSchema.nullable(),
        project: hubFileSchema.nullable(),
        projectLocal: hubFileSchema.nullable(),
        state: ownedStateSchema,
        files: z.array(
          z
            .object({
              path: z.string(),
              exists: z.boolean(),
              sha256: z.string().nullable(),
              owned: z.boolean(),
            })
            .strict(),
        ),
        foreign: z.array(foreignFileSchema),
      })
      .strict(),
  },
  apply: {
    input: z
      .object({
        files: z.array(targetFileSchema),
        /** Paths MCP Hub owns but no longer targets; deleted when unedited. */
        remove: z.array(z.string()),
        force: z.boolean(),
      })
      .strict(),
    output: z.object({ results: z.array(applyResultSchema) }).strict(),
  },
  saveServer: {
    input: z
      .object({
        scope: z.enum(["host", "project"]),
        projectPath: z.string().nullable(),
        name: z.string().min(1),
        previousName: z.string().min(1).nullable(),
        server: hubServerSchema,
        /** `${VAR}` values entered with the server; written to the same scope's mcp.local.json. */
        vars: z.record(z.string(), z.string()).nullable(),
      })
      .strict(),
    output: z.object({ path: z.string() }).strict(),
  },
  importServers: {
    input: z
      .object({
        scope: z.enum(["host", "project"]),
        projectPath: z.string().nullable(),
        entries: z.array(
          z
            .object({
              name: z.string().min(1),
              server: hubServerSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    output: z.object({ path: z.string() }).strict(),
  },
  revealVar: {
    input: z
      .object({
        scope: z.enum(["host", "project"]),
        projectPath: z.string().nullable(),
        name: z.string().min(1),
      })
      .strict(),
    output: z.object({ value: z.string().nullable() }).strict(),
  },
  envVars: {
    input: z.object({ names: z.array(z.string().min(1)) }).strict(),
    output: z
      .object({ values: z.record(z.string(), z.string().nullable()) })
      .strict(),
  },
  deleteServer: {
    input: z
      .object({
        scope: z.enum(["host", "project"]),
        projectPath: z.string().nullable(),
        name: z.string().min(1),
      })
      .strict(),
    output: z.object({ path: z.string() }).strict(),
  },
  setVar: {
    input: z
      .object({
        scope: z.enum(["host", "project"]),
        projectPath: z.string().nullable(),
        name: z.string().min(1),
        value: z.string().nullable(),
      })
      .strict(),
    output: z.object({ path: z.string() }).strict(),
  },
});
