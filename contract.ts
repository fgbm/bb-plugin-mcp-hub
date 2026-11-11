// Shared contract for the MCP Hub plugin.
//
// The host entry owns the file system: it reads the hub configuration files and
// writes the generated artifacts on the machine's home directory. The server
// entry owns the semantics: merging scopes, rendering each harness format and
// deciding what may be overwritten.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** One MCP server as authored in a hub file. */
export const hubServerSchema = z
  .object({
    /** Remote servers use a URL, local servers a command. */
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Defaults to true; false removes the server from generated files. */
    enabled: z.boolean().optional(),
  })
  .strict();

export type HubServer = z.infer<typeof hubServerSchema>;

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

export const applyResultSchema = z
  .object({
    path: z.string(),
    status: z.enum(["written", "unchanged", "foreign", "backed-up"]),
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
        /** Absolute host home directory as the daemon sees it. */
        paths: z.array(z.string()),
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
      })
      .strict(),
  },
  apply: {
    input: z
      .object({
        files: z.array(targetFileSchema),
        force: z.boolean(),
      })
      .strict(),
    output: z.object({ results: z.array(applyResultSchema) }).strict(),
  },
});
