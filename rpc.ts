// Contract between the MCP Hub page and the server entry.
//
// Everything the page may do lives here: read the merged state, edit a server in
// one scope, set a secret value, and apply. The overview lists secret names,
// sources and usage only; `revealVar` returns one value on explicit request.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  applyResultSchema,
  hubServerSchema,
  serverDefinitionSchema,
} from "./contract.js";

export const scopeSchema = z.enum(["host", "project"]);

export const overviewSchema = z
  .object({
    hostId: z.string(),
    hostName: z.string(),
    /** Enrolled hosts the page can switch between. */
    hosts: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
        })
        .strict(),
    ),
    home: z.string(),
    projectId: z.string().nullable(),
    projectPath: z.string().nullable(),
    projectAuthored: z.boolean().nullable(),
    projects: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          /** Source path on this host, or null when the project lives elsewhere. */
          path: z.string().nullable(),
        })
        .strict(),
    ),
    servers: z.array(
      z
        .object({
          name: z.string(),
          server: hubServerSchema,
          scope: scopeSchema,
          /** False when the hub file carries `"enabled": false`. */
          enabled: z.boolean(),
          /** Harnesses whose config for this workspace contains the server. */
          materialized: z.array(z.string()),
          /** Harness files that already define this name differently. */
          collisions: z.array(z.string()),
        })
        .strict(),
    ),
    vars: z.array(
      z
        .object({
          name: z.string(),
          /** Authored servers that reference the name, disabled ones included. */
          usedBy: z.array(z.string()),
          /** A value is stored in ~/.bb/mcp.local.json. */
          host: z.boolean(),
          /** A value is stored in <repo>/.bb/mcp.local.json. */
          project: z.boolean(),
          /** The host process environment provides a value. */
          environment: z.boolean(),
          /** True when a value is available to expand the reference. */
          resolved: z.boolean(),
        })
        .strict(),
    ),
    unresolved: z.array(z.string()),
    targets: z.array(
      z
        .object({
          path: z.string(),
          exists: z.boolean(),
          owned: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type Overview = z.infer<typeof overviewSchema>;

export const projectSourcesSchema = z
  .object({
    path: z.string().nullable(),
    files: z.array(
      z
        .object({
          path: z.string(),
          kind: z.string(),
          error: z.string().nullable(),
          servers: z.array(
            z
              .object({
                name: z.string().min(1),
                server: hubServerSchema,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export type ProjectSources = z.infer<typeof projectSourcesSchema>;

export const uiContract = defineRpcContract({
  overview: {
    experimental_description: "Merged host and project state for one project.",
    input: z
      .object({
        /** Null picks this machine's primary host. */
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: overviewSchema,
  },
  saveServer: {
    experimental_description: "Write one server into a hub file and re-apply.",
    input: z
      .object({
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
        scope: scopeSchema,
        name: z.string().min(1),
        /** The name this entry had before a rename, if any. */
        previousName: z.string().min(1).nullable(),
        server: serverDefinitionSchema,
        /** Values entered with the server; written to the same scope's mcp.local.json. */
        vars: z.record(z.string(), z.string()).nullable(),
      })
      .strict(),
    output: z.object({ results: z.array(applyResultSchema) }).strict(),
  },
  importServers: {
    experimental_description:
      "Write several servers found in a project's harness files into its hub file and re-apply.",
    input: z
      .object({
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
        scope: scopeSchema,
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
    output: z.object({ results: z.array(applyResultSchema) }).strict(),
  },
  projectSources: {
    experimental_description:
      "MCP servers a project's own harness files already configure, for import.",
    input: z
      .object({
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: projectSourcesSchema,
  },
  revealVar: {
    experimental_description:
      "Read one stored secret value on explicit request; null when it is not set in that scope.",
    input: z
      .object({
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
        scope: scopeSchema,
        name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
      })
      .strict(),
    output: z.object({ value: z.string().nullable() }).strict(),
  },
  deleteServer: {
    experimental_description: "Remove one server from a hub file and re-apply.",
    input: z
      .object({
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
        scope: scopeSchema,
        name: z.string().min(1),
      })
      .strict(),
    output: z.object({ results: z.array(applyResultSchema) }).strict(),
  },
  setVar: {
    experimental_description: "Set or clear a value in mcp.local.json; null clears.",
    input: z
      .object({
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
        scope: scopeSchema,
        name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
        value: z.string().nullable(),
      })
      .strict(),
    output: z.object({ results: z.array(applyResultSchema) }).strict(),
  },
  setEnabled: {
    experimental_description: "Turn one authored server on or off and re-apply.",
    input: z
      .object({
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
        scope: scopeSchema,
        name: z.string().min(1),
        enabled: z.boolean(),
      })
      .strict(),
    output: z.object({ results: z.array(applyResultSchema) }).strict(),
  },
  apply: {
    experimental_description: "Rewrite every generated harness file. Foreign files report `foreign` unless forced.",
    input: z
      .object({
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
        force: z.boolean(),
      })
      .strict(),
    output: z.object({ results: z.array(applyResultSchema) }).strict(),
  },
  threadTarget: {
    experimental_description: "The host and project a thread runs on.",
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        hostId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
  },
});
