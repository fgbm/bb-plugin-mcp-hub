// Server entry: one source of truth for MCP servers across harnesses.
//
// Host scope lives in ~/.bb/mcp.json, project scope in <repo>/.bb/mcp.json, and
// secrets in the sibling mcp.local.json files. The server merges the scopes,
// expands ${VAR} references, renders each harness format and asks the host
// entry to write the artifacts it owns. Nothing is ever merged into a harness
// configuration that also holds other settings.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  hostContract,
  type HubFile,
  type HubServer,
  type TargetFile,
} from "./contract.js";

/** Join paths for the target host, which may run a different platform. */
function joinHost(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") ? "\\" : "/";
  let out = base.replace(/[/\\]+$/u, "");
  for (const part of parts) out += sep + part.replace(/^[/\\]+/u, "");
  return out;
}

const VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/gu;

type VarMap = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readVars(file: HubFile | null): VarMap {
  if (file === null) return {};
  const vars = (file as Record<string, unknown>)["vars"];
  if (!isRecord(vars)) return {};
  const out: VarMap = {};
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function collectVars(files: Array<HubFile | null>): VarMap {
  const out: VarMap = {};
  for (const file of files) Object.assign(out, readVars(file));
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && out[key] === undefined) out[key] = value;
  }
  return out;
}

function expandString(value: string, vars: VarMap): string {
  return value.replace(VAR_PATTERN, (match, name: string) => vars[name] ?? match);
}

function expandServer(server: HubServer, vars: VarMap): HubServer {
  const expandMap = (input: Record<string, string> | undefined) =>
    input === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(input).map(([key, value]) => [key, expandString(value, vars)]),
        );
  return {
    ...(server.url === undefined ? {} : { url: expandString(server.url, vars) }),
    ...(server.headers === undefined ? {} : { headers: expandMap(server.headers) }),
    ...(server.command === undefined
      ? {}
      : { command: expandString(server.command, vars) }),
    ...(server.args === undefined
      ? {}
      : { args: server.args.map((arg) => expandString(arg, vars)) }),
    ...(server.env === undefined ? {} : { env: expandMap(server.env) }),
    ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
  };
}

/** Later layers override earlier ones by server name; order is preserved. */
function mergeServers(
  layers: Array<HubFile | null>,
  vars: VarMap,
): Array<{ name: string; server: HubServer }> {
  const merged = new Map<string, HubServer>();
  for (const layer of layers) {
    if (layer === null) continue;
    for (const [name, raw] of Object.entries(layer.servers)) {
      if (raw.enabled === false) {
        merged.delete(name);
        continue;
      }
      merged.set(name, expandServer(raw, vars));
    }
  }
  return [...merged.entries()].map(([name, server]) => ({ name, server }));
}

interface RenderedServer {
  remote: boolean;
  url: string | null;
  headers: Record<string, string> | null;
  command: string | null;
  args: string[];
  env: Record<string, string> | null;
}

function toRendered(server: HubServer): RenderedServer {
  return {
    remote: server.url !== undefined,
    url: server.url ?? null,
    headers: server.headers ?? null,
    command: server.command ?? null,
    args: server.args ?? [],
    env: server.env ?? null,
  };
}

/** Claude Code and Kimi Code share this shape; extra keys are tolerated. */
function renderShared(servers: Array<{ name: string; server: HubServer }>): string {
  const mcpServers: Record<string, unknown> = {};
  for (const { name, server } of servers) {
    const entry = toRendered(server);
    if (entry.remote) {
      mcpServers[name] = {
        type: "http",
        url: entry.url,
        ...(entry.headers === null ? {} : { headers: entry.headers }),
      };
      continue;
    }
    mcpServers[name] = {
      ...(entry.command === null ? {} : { command: entry.command }),
      ...(entry.args.length === 0 ? {} : { args: entry.args }),
      ...(entry.env === null ? {} : { env: entry.env }),
    };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

function renderOpencode(servers: Array<{ name: string; server: HubServer }>): string {
  const mcp: Record<string, unknown> = {};
  for (const { name, server } of servers) {
    const entry = toRendered(server);
    mcp[name] = entry.remote
      ? {
          type: "remote",
          url: entry.url,
          ...(entry.headers === null ? {} : { headers: entry.headers }),
        }
      : {
          type: "local",
          command: [entry.command ?? "", ...entry.args],
          ...(entry.env === null ? {} : { environment: entry.env }),
        };
  }
  return `${JSON.stringify(
    { $schema: "https://opencode.ai/config.json", mcp },
    null,
    2,
  )}\n`;
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function tomlTable(input: Record<string, string>): string {
  const pairs = Object.entries(input).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`,
  );
  return `{ ${pairs.join(", ")} }`;
}

function renderCodex(servers: Array<{ name: string; server: HubServer }>): string {
  const blocks: string[] = [];
  for (const { name, server } of servers) {
    const entry = toRendered(server);
    const lines = [`[mcp_servers.${tomlString(name)}]`];
    if (entry.remote) {
      lines.push(`url = ${tomlString(entry.url ?? "")}`);
      if (entry.headers !== null) lines.push(`http_headers = ${tomlTable(entry.headers)}`);
    } else {
      if (entry.command !== null) lines.push(`command = ${tomlString(entry.command)}`);
      if (entry.args.length > 0) {
        lines.push(`args = [${entry.args.map(tomlString).join(", ")}]`);
      }
      if (entry.env !== null) lines.push(`env = ${tomlTable(entry.env)}`);
    }
    blocks.push(lines.join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

const TARGET_IDS = ["kimi-user", "opencode", "project", "cursor-export", "codex-export"] as const;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    injectOpencode: {
      type: "boolean",
      label: "Inject MCP servers into OpenCode threads",
      description:
        "Point OPENCODE_CONFIG at MCP Hub's generated file so OpenCode threads start with the merged servers. Turn off to manage OpenCode yourself.",
      default: true,
    },
  });

  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const homeByHost = new Map<string, string>();
  const opencodeReady = new Set<string>();

  async function snapshot(hostId: string, projectPath: string | null) {
    return hostClient.call(
      "snapshot",
      { projectPath, paths: [] },
      { hostId, signal: AbortSignal.timeout(30_000) },
    );
  }

  async function warmHost(hostId: string): Promise<void> {
    try {
      const snapshotResult = await snapshot(hostId, null);
      homeByHost.set(hostId, snapshotResult.home);
      const opencodePath = joinHost(snapshotResult.home, ".bb", "mcp", "opencode.json");
      const withPath = await hostClient.call(
        "snapshot",
        { projectPath: null, paths: [opencodePath] },
        { hostId, signal: AbortSignal.timeout(30_000) },
      );
      const file = withPath.files.find((candidate) => candidate.path === opencodePath);
      if (file?.owned === true) opencodeReady.add(hostId);
    } catch {
      // A disconnected host simply stays cold; the next call retries.
    }
  }

  // Warm the home-directory cache so the env contribution answers inside its
  // five-second budget on the first turn after a restart.
  bb.background.service("warm-hosts", {
    async start(signal) {
      const hosts = await bb.sdk.hosts.list({ includeCreating: false });
      await Promise.all(
        hosts
          .filter((host) => host.status === "connected" && host.type !== "ephemeral")
          .map(async (host) => {
            if (signal.aborted) return;
            await warmHost(host.id);
          }),
      );
    },
  });

  // OpenCode merges OPENCODE_CONFIG between its global and project configs, so
  // a generated file that only carries `mcp` adds servers without touching the
  // user's own configuration. A project-level file wins when apply produced one
  // for the thread's workspace.
  const OPENCODE_FILE = [".bb", "mcp", "opencode.json"] as const;
  const existsCache = new Map<string, { at: number; value: boolean }>();

  async function hostFileExists(hostId: string, path: string): Promise<boolean> {
    const key = `${hostId}\u0000${path}`;
    const hit = existsCache.get(key);
    const now = Date.now();
    if (hit !== undefined && now - hit.at < 30_000) return hit.value;
    try {
      const result = await hostClient.call(
        "snapshot",
        { projectPath: null, paths: [path] },
        { hostId, signal: AbortSignal.timeout(5_000) },
      );
      const exists = result.files[0]?.exists === true;
      existsCache.set(key, { at: now, value: exists });
      return exists;
    } catch {
      return false;
    }
  }

  const projectPathCache = new Map<string, { at: number; path: string | null }>();

  async function workspacePath(
    hostId: string,
    threadId: string | null,
    projectId: string | null,
  ): Promise<string | null> {
    const key = `${hostId}\u0000${threadId ?? projectId ?? ""}`;
    const hit = projectPathCache.get(key);
    const now = Date.now();
    if (hit !== undefined && now - hit.at < 60_000) return hit.path;
    let path: string | null = null;
    try {
      if (threadId !== null) {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== null) {
          const environment = await bb.sdk.environments.get({
            environmentId: thread.environmentId,
          });
          if (environment.hostId === hostId) path = environment.path;
        }
      }
      if (path === null && projectId !== null) {
        const project = await bb.sdk.projects.get({ projectId });
        const source =
          project.sources.find((candidate) => candidate.hostId === hostId) ??
          project.sources.find((candidate) => candidate.isDefault);
        path = source?.path ?? null;
      }
    } catch {
      path = null;
    }
    projectPathCache.set(key, { at: now, path });
    return path;
  }

  bb.providers.experimental_contributeEnv("acp-opencode", async (context) => {
    const enabled = (await settings.get()).injectOpencode;
    if (!enabled) return [];
    let home = homeByHost.get(context.hostId);
    if (home === undefined) {
      await warmHost(context.hostId);
      home = homeByHost.get(context.hostId);
    }
    if (home === undefined) return [];
    let target = joinHost(home, ...OPENCODE_FILE);
    if (!opencodeReady.has(context.hostId)) {
      // A project file is written by apply even when the host one is not owned.
      const workspace = await workspacePath(
        context.hostId,
        context.threadId,
        context.projectId,
      );
      if (workspace === null) return [];
      const candidate = joinHost(workspace, ...OPENCODE_FILE);
      if (!(await hostFileExists(context.hostId, candidate))) return [];
      target = candidate;
      return [
        {
          name: "OPENCODE_CONFIG",
          value: target,
          reason: "MCP Hub project MCP servers for OpenCode",
        },
      ];
    }
    const workspace = await workspacePath(
      context.hostId,
      context.threadId,
      context.projectId,
    );
    if (workspace !== null) {
      const candidate = joinHost(workspace, ...OPENCODE_FILE);
      if (await hostFileExists(context.hostId, candidate)) target = candidate;
    }
    return [
      {
        name: "OPENCODE_CONFIG",
        value: target,
        reason: "MCP Hub merged MCP servers for OpenCode",
      },
    ];
  });

  interface ResolvedTarget {
    hostId: string;
    projectPath: string | null;
    hostName: string;
  }

  async function resolveTarget(options: {
    hostId?: string;
    path?: string;
    threadId?: string;
    projectId?: string;
    cwd?: string;
  }): Promise<ResolvedTarget> {
    let hostId = options.hostId;
    const projectPath = options.path ?? options.cwd ?? null;
    if (hostId === undefined && options.threadId !== undefined) {
      const thread = await bb.sdk.threads.get({ threadId: options.threadId });
      if (thread.environmentId !== null) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        hostId = environment.hostId;
      }
    }
    if (hostId === undefined) {
      const config = await bb.sdk.system.config();
      hostId = config.primaryHostId ?? undefined;
    }
    if (hostId === undefined) throw new Error("No host to target; pass --host <id>.");
    const hosts = await bb.sdk.hosts.list({ includeCreating: false });
    const host =
      hosts.find((candidate) => candidate.id === hostId) ??
      hosts.find((candidate) => candidate.name === hostId);
    if (host === undefined) {
      throw new Error(`Unknown host "${hostId ?? ""}".`);
    }
    return { hostId: host.id, projectPath, hostName: host.name };
  }

  async function buildPlan(
    target: ResolvedTarget,
    force: boolean,
    embedSecrets: boolean,
  ) {
    const snap = await snapshot(target.hostId, target.projectPath);
    const vars = collectVars([snap.hostLocal, snap.projectLocal]);
    const servers = mergeServers([snap.host, snap.project], vars);
    // Host-scope files must not inherit project servers, or one repository's
    // connectors would leak into every other project on the machine.
    const hostServers = mergeServers([snap.host], collectVars([snap.hostLocal]));
    const home = snap.home;

    const localVars: VarMap = {
      ...readVars(snap.hostLocal),
      ...readVars(snap.projectLocal),
    };
    const localValues = Object.values(localVars).filter((value) => value !== "");
    const usesSecret = (server: HubServer): boolean => {
      const json = JSON.stringify(server);
      return localValues.some((value) => json.includes(value));
    };
    // A committed project file must not carry values from mcp.local.json, so
    // those servers are left out unless the caller asks for them explicitly.
    const excludedServers = embedSecrets
      ? []
      : servers.filter((entry) => usesSecret(entry.server)).map((entry) => entry.name);
    const projectServers = servers.filter(
      (entry) => !excludedServers.includes(entry.name),
    );

    const files: TargetFile[] = [
      {
        path: joinHost(home, ".kimi-code", "mcp.json"),
        content: renderShared(hostServers),
        mode: 0o600,
      },
      {
        path: joinHost(home, ".bb", "mcp", "opencode.json"),
        content: renderOpencode(hostServers),
        mode: 0o600,
      },
      {
        path: joinHost(home, ".bb", "mcp", "export", "cursor-mcp.json"),
        content: renderShared(servers),
        mode: 0o600,
      },
      {
        path: joinHost(home, ".bb", "mcp", "export", "codex-config.toml"),
        content: renderCodex(servers),
        mode: 0o600,
      },
    ];
    if (target.projectPath !== null) {
      files.push({
        path: joinHost(target.projectPath, ".mcp.json"),
        content: renderShared(projectServers),
        mode: 0o600,
      });
      files.push({
        path: joinHost(target.projectPath, ".bb", "mcp", ".gitignore"),
        content: "*\n",
        mode: 0o600,
      });
      files.push({
        path: joinHost(target.projectPath, ...OPENCODE_FILE),
        // This file may carry values from mcp.local.json; keep it out of git.
        content: renderOpencode(servers),
        mode: 0o600,
      });
    }

    const paths = files.map((file) => file.path);
    const status = await hostClient.call(
      "snapshot",
      { projectPath: target.projectPath, paths },
      { hostId: target.hostId, signal: AbortSignal.timeout(30_000) },
    );
    return {
      files,
      servers,
      vars,
      snap,
      status,
      unresolved: collectUnresolved(servers),
      excludedServers,
      embeddedSecrets: [],
      force,
    };
  }

  function collectUnresolved(
    servers: Array<{ name: string; server: HubServer }>,
  ): string[] {
    const missing = new Set<string>();
    const scan = (value: unknown) => {
      if (typeof value === "string") {
        for (const match of value.matchAll(VAR_PATTERN)) missing.add(match[1]);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) scan(item);
        return;
      }
      if (isRecord(value)) {
        for (const item of Object.values(value)) scan(item);
      }
    };
    scan(servers.map((entry) => entry.server));
    return [...missing];
  }

  function describe(
    plan: Awaited<ReturnType<typeof buildPlan>>,
  ): string {
    const lines: string[] = [];
    lines.push(`Servers: ${String(plan.servers.length)}`);
    for (const { name, server } of plan.servers) {
      lines.push(
        `  ${name}  ${server.url === undefined ? `stdio: ${server.command ?? "?"}` : `http: ${server.url}`}`,
      );
    }
    if (plan.unresolved.length > 0) {
      lines.push(`Unresolved variables: ${plan.unresolved.join(", ")}`);
    }
    if (plan.excludedServers.length > 0) {
      lines.push(
        `Left out of the project .mcp.json because they use mcp.local.json values: ${plan.excludedServers.join(", ")}.`,
      );
    }
    lines.push("Files:");
    for (const file of plan.files) {
      const state = plan.status.files.find((candidate) => candidate.path === file.path);
      const verdict =
        state === undefined || !state.exists
          ? "missing"
          : state.owned
            ? "owned"
            : "foreign";
      lines.push(`  ${verdict.padEnd(8)} ${file.path}`);
    }
    return lines.join("\n");
  }

  function formatResults(results: Array<{ path: string; status: string; message: string | null }>): string {
    return results
      .map(
        (result) =>
          `${result.status.padEnd(9)} ${result.path}${result.message === null ? "" : `\n          ${result.message}`}`,
      )
      .join("\n");
  }

  const usage = [
    "Usage:",
    "  bb mcp-hub status [--host <id>] [--path <dir>] [--json]",
    "  bb mcp-hub plan   [--host <id>] [--path <dir>] [--json]",
    "  bb mcp-hub apply  [--host <id>] [--path <dir>] [--force] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "mcp-hub",
    summary: "Merge MCP servers from host and project hub files into each harness",
    commands: [
      { name: "status", summary: "Show merged servers and target file state", usage: "bb mcp-hub status [--host <id>] [--path <dir>]" },
      { name: "plan", summary: "Show what apply would write", usage: "bb mcp-hub plan [--host <id>] [--path <dir>]" },
      { name: "apply", summary: "Write the generated files", usage: "bb mcp-hub apply [--host <id>] [--path <dir>] [--force]" },
    ],
    async run(argv, context) {
      const json = argv.includes("--json");
      const force = argv.includes("--force");
      const hostIndex = argv.indexOf("--host");
      const pathIndex = argv.indexOf("--path");
      const hostFlag = hostIndex >= 0 ? argv[hostIndex + 1] : undefined;
      const pathFlag = pathIndex >= 0 ? argv[pathIndex + 1] : undefined;
      const command = argv.find((arg) => !arg.startsWith("--") && arg !== hostFlag && arg !== pathFlag);

      if (command === undefined || command === "help" || command === "--help") {
        return { exitCode: 0, stdout: usage };
      }
      if (!["status", "plan", "apply"].includes(command)) {
        return { exitCode: 1, stderr: usage };
      }

      const target = await resolveTarget({
        ...(hostFlag === undefined ? {} : { hostId: hostFlag }),
        ...(pathFlag === undefined ? {} : { path: pathFlag }),
        ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
        ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
        ...(hostFlag !== undefined || context.cwd === undefined
          ? {}
          : { cwd: context.cwd }),
      });

      const embedSecrets = argv.includes("--embed-secrets");
      const plan = await buildPlan(target, force, embedSecrets);
      if (command === "status") {
        if (json) {
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              {
                host: target.hostName,
                hostId: target.hostId,
                projectPath: target.projectPath,
                servers: plan.servers,
                unresolved: plan.unresolved,
                files: plan.files.map((file) => ({
                  path: file.path,
                  ...plan.status.files.find((candidate) => candidate.path === file.path),
                })),
              },
              null,
              2,
            ),
          };
        }
        return {
          exitCode: 0,
          stdout: `${target.hostName}\n${describe(plan)}`,
        };
      }

      if (command === "plan") {
        const text = plan.files
          .map((file) => {
            const state = plan.status.files.find((candidate) => candidate.path === file.path);
            const action =
              state === undefined || !state.exists
                ? "create"
                : state.owned
                  ? "update"
                  : force
                    ? "backup+overwrite"
                    : "skip (foreign)";
            return `${action.padEnd(16)} ${file.path}`;
          })
          .join("\n");
        return { exitCode: 0, stdout: json ? JSON.stringify({ files: plan.files.map(({ path, content }) => ({ path, content })) }, null, 2) : text };
      }

      const applied = await hostClient.call(
        "apply",
        { files: plan.files, force },
        { hostId: target.hostId, signal: AbortSignal.timeout(60_000) },
      );
      homeByHost.set(target.hostId, plan.snap.home);
      const opencodeResult = applied.results.find(
        (result) => result.path === joinHost(plan.snap.home, ".bb", "mcp", "opencode.json"),
      );
      if (opencodeResult?.status === "written" || opencodeResult?.status === "unchanged") {
        opencodeReady.add(target.hostId);
      }
      if (target.projectPath !== null) {
        existsCache.delete(
          `${target.hostId}\u0000${joinHost(target.projectPath, ...OPENCODE_FILE)}`,
        );
      }
      const failed = applied.results.some((result) => result.status === "foreign");
      const warnings: string[] = [];
      if (failed && !force) {
        warnings.push("Some files were left alone; rerun with --force to take them over.");
      }
      if (plan.excludedServers.length > 0) {
        warnings.push(
          `Left out of the project .mcp.json because they use mcp.local.json values: ${plan.excludedServers.join(", ")}. Pass --embed-secrets to include them.`,
        );
      }
      if (embedSecrets && plan.vars !== undefined) {
        warnings.push(
          "The project .mcp.json now embeds expanded values; do not commit it.",
        );
      }
      return {
        exitCode: failed && !force ? 1 : 0,
        stdout: json
          ? JSON.stringify({ results: applied.results }, null, 2)
          : formatResults(applied.results),
        ...(warnings.length === 0 ? {} : { stderr: warnings.join("\n") }),
      };
    },
  });
}










