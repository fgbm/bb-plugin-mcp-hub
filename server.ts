// Server entry: one source of truth for MCP servers across harnesses.
//
// Host scope lives in ~/.bb/mcp.json, project scope in <repo>/.bb/mcp.json, and
// secrets in the sibling mcp.local.json files. The server merges the scopes,
// expands ${VAR} references, renders each harness format and asks the host
// entry to write the artifacts it owns. Nothing is ever merged into a harness
// configuration that also holds other settings.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import {
  hostContract,
  type ApplyResult,
  type HubFile,
  type HubServer,
  type TargetFile,
} from "./contract.js";
import { uiContract, type Overview } from "./rpc.js";
import {
  MANAGED_SERVER_KEYS,
  VAR_PATTERN,
  isRecord,
  readVars,
  referencedVars,
  serverEntries,
  serverFromEntry,
  type HarnessKind,
} from "./shared.js";

/** Where the OpenCode project file lives inside a workspace. */
const OPENCODE_FILE = [".bb", "mcp", "opencode.json"] as const;

const CLI_COMMANDS = ["status", "plan", "apply"] as const;

type CliCommand = (typeof CLI_COMMANDS)[number];

interface CliArgs {
  command: CliCommand | null;
  /** A positional argument that is not one of the commands. */
  invalid: boolean;
  json: boolean;
  force: boolean;
  embedSecrets: boolean;
  host: string | null;
  path: string | null;
}

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const next = argv[index + 1];
  return next === undefined || next.startsWith("--") ? null : next;
}

/** A flag with no value would otherwise fall back to the thread's cwd. */
function flagMissingValue(argv: string[], name: string): boolean {
  return argv.includes(name) && flagValue(argv, name) === null;
}

function isAbsoluteHostPath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/u.test(value);
}

function parseCliArgs(argv: string[]): CliArgs {
  const host = flagValue(argv, "--host");
  const path = flagValue(argv, "--path");
  const flagValues = new Set([host, path]);
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const command = positional.find(isCliCommand) ?? null;
  const invalid =
    flagMissingValue(argv, "--host") ||
    flagMissingValue(argv, "--path") ||
    positional.some(
      (arg) => arg !== "help" && !isCliCommand(arg) && !flagValues.has(arg),
    );
  return {
    command,
    invalid,
    json: argv.includes("--json"),
    force: argv.includes("--force"),
    embedSecrets: argv.includes("--embed-secrets"),
    host,
    path,
  };
}

function isCliCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value);
}

/** Join paths for the target host, which may run a different platform. */
export function joinHost(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") ? "\\" : "/";
  let out = base.replace(/[/\\]+$/u, "");
  for (const part of parts) out += sep + part.replace(/^[/\\]+/u, "");
  return out;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Names a hub file may use; the page validates with the same set. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

type VarMap = Record<string, string>;

/** Hub values win over the target host's environment. */
function collectVars(files: Array<HubFile | null>, env: VarMap): VarMap {
  const out: VarMap = {};
  for (const file of files) Object.assign(out, readVars(file));
  for (const [key, value] of Object.entries(env)) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

function expandString(value: string, vars: VarMap): string {
  return value.replace(VAR_PATTERN, (match, name: string) => vars[name] ?? match);
}

/** Resolve `${VAR}` at any depth, keeping keys MCP Hub does not know about. */
function expandValue(value: unknown, vars: VarMap): unknown {
  if (typeof value === "string") return expandString(value, vars);
  if (Array.isArray(value)) return value.map((item) => expandValue(item, vars));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandValue(item, vars)]),
    );
  }
  return value;
}

function expandServer(server: HubServer, vars: VarMap): HubServer {
  return expandValue(server, vars) as HubServer;
}

/** Keys MCP Hub renders itself; everything else passes through to the harness. */
const RENDERED_SERVER_KEYS = new Set<string>(MANAGED_SERVER_KEYS);

function passthroughKeys(server: HubServer): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(server).filter(([key]) => !RENDERED_SERVER_KEYS.has(key)),
  );
}

/** Later layers override earlier ones by server name; order is preserved. */
function mergeServers(
  layers: Array<HubFile | null>,
): Array<{ name: string; server: HubServer }> {
  const merged = new Map<string, HubServer>();
  for (const layer of layers) {
    if (layer === null) continue;
    for (const [name, raw] of Object.entries(layer.servers)) {
      if (raw.enabled === false) {
        merged.delete(name);
        continue;
      }
      merged.set(name, raw);
    }
  }
  return [...merged.entries()].map(([name, server]) => ({ name, server }));
}

interface AuthoredServer {
  name: string;
  server: HubServer;
  scope: "host" | "project";
  enabled: boolean;
}

/** Every entry the hub files author, disabled ones included, project winning by name. */
function authoredServers(snap: {
  host: HubFile | null;
  project: HubFile | null;
}): AuthoredServer[] {
  const authored = new Map<string, AuthoredServer>();
  for (const [name, server] of Object.entries(snap.host?.servers ?? {})) {
    authored.set(name, { name, server, scope: "host", enabled: server.enabled !== false });
  }
  for (const [name, server] of Object.entries(snap.project?.servers ?? {})) {
    authored.set(name, {
      name,
      server,
      scope: "project",
      enabled: server.enabled !== false,
    });
  }
  return [...authored.values()];
}

/**
 * Servers a committed project file must leave out: their values come from
 * mcp.local.json or the target host's environment, neither of which belongs in
 * a file that is pushed to a remote.
 */
function excludedBySecretVars(
  snap: { hostLocal: HubFile | null; projectLocal: HubFile | null },
  servers: Array<{ name: string; server: HubServer }>,
  env: VarMap,
): string[] {
  const localVars: VarMap = {
    ...readVars(snap.hostLocal),
    ...readVars(snap.projectLocal),
  };
  const names = new Set(
    [...Object.entries(localVars), ...Object.entries(env)]
      .filter(([, value]) => value !== "")
      .map(([name]) => name),
  );
  return servers
    .filter((entry) => usesLocalVar(entry.server, names))
    .map((entry) => entry.name);
}

/** A project that authors nothing gets no committed files of its own. */
function projectAuthoredFor(
  projectPath: string | null,
  project: HubFile | null,
): boolean | null {
  if (projectPath === null) return null;
  return project !== null && Object.keys(project.servers).length > 0;
}

/** Files a project scope owns: kept in one place so removal can find them. */
function projectTargetPaths(projectPath: string): [string, string, string] {
  return [
    joinHost(projectPath, ".mcp.json"),
    // Sits next to mcp.local.json, so one file can ignore both it and mcp/.
    joinHost(projectPath, ".bb", ".gitignore"),
    joinHost(projectPath, ...OPENCODE_FILE),
  ];
}

/** The old ignore file lived inside mcp/ and never covered mcp.local.json. */
function legacyProjectIgnore(projectPath: string): string {
  return joinHost(projectPath, ".bb", "mcp", ".gitignore");
}

/** Which harnesses MCP Hub writes for; set from the plugin's settings. */
export interface TargetSelection {
  kimiCode: boolean;
  claudeCode: boolean;
  opencode: boolean;
  cursor: boolean;
  codex: boolean;
}

function hostTargetPaths(home: string): string[] {
  return [
    joinHost(home, ".kimi-code", "mcp.json"),
    joinHost(home, ".bb", "mcp", "opencode.json"),
    joinHost(home, ".bb", "mcp", "export", "claude-user-mcp.json"),
    joinHost(home, ".bb", "mcp", "export", "cursor-mcp.json"),
    joinHost(home, ".bb", "mcp", "export", "codex-config.toml"),
  ];
}

/** Order the page lists harnesses in; independent of file order below. */
const HARNESS_ORDER = ["opencode", "kimi", "claude", "cursor", "codex"] as const;

/** Server name → harnesses whose generated file contains it. */
export type Reaches = Record<string, string[]>;

export function renderTargets(input: {
  home: string;
  projectPath: string | null;
  projectAuthored: boolean | null;
  /** A project mcp.local.json exists and must stay out of git even without servers. */
  projectLocal: boolean;
  targets: TargetSelection;
  hostServers: Array<{ name: string; server: HubServer }>;
  servers: Array<{ name: string; server: HubServer }>;
  projectServers: Array<{ name: string; server: HubServer }>;
}): { files: TargetFile[]; reaches: Reaches } {
  const files: TargetFile[] = [];
  const reached = new Map<string, Set<string>>();
  const mark = (label: string, servers: Array<{ name: string }>) => {
    for (const { name } of servers) {
      const labels = reached.get(name) ?? new Set<string>();
      labels.add(label);
      reached.set(name, labels);
    }
  };
  const reaches = (): Reaches =>
    Object.fromEntries(
      [...reached.entries()].map(([name, labels]) => [
        name,
        HARNESS_ORDER.filter((label) => labels.has(label)),
      ]),
    );
  if (input.targets.kimiCode) {
    files.push({
      path: joinHost(input.home, ".kimi-code", "mcp.json"),
      content: renderShared(input.hostServers),
      mode: 0o600,
    });
    mark("kimi", input.hostServers);
  }
  if (input.targets.opencode) {
    files.push({
      path: joinHost(input.home, ".bb", "mcp", "opencode.json"),
      content: renderOpencode(input.hostServers),
      mode: 0o600,
    });
    mark("opencode", input.hostServers);
  }
  if (input.targets.claudeCode) {
    // Claude Code keeps user-scope servers in ~/.claude.json, which also holds
    // its own session state; MCP Hub will not merge into it. This export is the
    // copy a user adds with `claude mcp add-json --scope user`.
    files.push({
      path: joinHost(input.home, ".bb", "mcp", "export", "claude-user-mcp.json"),
      content: renderShared(input.hostServers),
      mode: 0o600,
    });
    mark("claude", input.hostServers);
  }
  if (input.targets.cursor) {
    files.push({
      path: joinHost(input.home, ".bb", "mcp", "export", "cursor-mcp.json"),
      content: renderShared(input.servers),
      mode: 0o600,
    });
    mark("cursor", input.servers);
  }
  if (input.targets.codex) {
    files.push({
      path: joinHost(input.home, ".bb", "mcp", "export", "codex-config.toml"),
      content: renderCodex(input.servers),
      mode: 0o600,
    });
    mark("codex", input.servers);
  }

  if (input.projectPath !== null && (input.projectAuthored === true || input.projectLocal)) {
    // Everything under .bb/mcp/ and the local values stay out of git; the hub
    // file `.bb/mcp.json` itself is committed.
    const [, gitignore] = projectTargetPaths(input.projectPath);
    files.push({
      path: gitignore,
      content: "mcp.local.json\nmcp/\n",
      mode: 0o600,
    });
  }
  if (input.projectPath === null || input.projectAuthored !== true) {
    return { files, reaches: reaches() };
  }
  const [manifest, , opencode] = projectTargetPaths(input.projectPath);
  // Claude Code and Kimi Code share the project `.mcp.json`.
  if (input.targets.kimiCode || input.targets.claudeCode) {
    files.push({
      path: manifest,
      content: renderShared(input.projectServers),
      mode: 0o600,
    });
    if (input.targets.kimiCode) mark("kimi", input.projectServers);
    if (input.targets.claudeCode) mark("claude", input.projectServers);
  }
  if (input.targets.opencode) {
    files.push({
      // This file may carry values from mcp.local.json; keep it out of git.
      path: opencode,
      content: renderOpencode(input.servers),
      mode: 0o600,
    });
    mark("opencode", input.servers);
  }
  return { files, reaches: reaches() };
}

/**
 * A harness reads its own config first and our generated file second, so a
 * server whose name already exists there is a silent override. Report it.
 */
export function findCollisions(
  sources: ForeignSource[],
  files: Array<{
    path: string;
    exists: boolean;
    json: unknown;
    error: string | null;
  }>,
  servers: Array<{ name: string; server: HubServer }>,
): Collision[] {
  const collisions: Collision[] = [];
  for (const source of sources) {
    const file = files.find((candidate) => candidate.path === source.path);
    if (file === undefined || !file.exists || file.error !== null) continue;
    const theirs = serverEntries(source.kind, file.json);
    if (theirs === null) continue;
    for (const { name, server } of servers) {
      if (theirs[name] === undefined) continue;
      const theirSignature = connectionSignature(theirs[name]);
      const ourOwn = ourSignature(server, source.kind);
      if (theirSignature === null || ourOwn === null) continue;
      if (theirSignature === ourOwn) continue;
      collisions.push({ server: name, path: source.path });
    }
  }
  return collisions;
}

/** Resolve `${VAR}` references for rendering; the merged list stays unauthored. */
function expandServers(
  servers: Array<{ name: string; server: HubServer }>,
  vars: VarMap,
): Array<{ name: string; server: HubServer }> {
  return servers.map(({ name, server }) => ({ name, server: expandServer(server, vars) }));
}

function usesLocalVar(server: HubServer, names: Set<string>): boolean {
  return referencedVars(server).some((name) => names.has(name));
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
export function renderShared(servers: Array<{ name: string; server: HubServer }>): string {
  const mcpServers: Record<string, unknown> = {};
  for (const { name, server } of servers) {
    const entry = toRendered(server);
    if (entry.remote) {
      mcpServers[name] = {
        ...passthroughKeys(server),
        type: server.type === "sse" ? "sse" : "http",
        url: entry.url,
        ...(entry.headers === null ? {} : { headers: entry.headers }),
      };
      continue;
    }
    mcpServers[name] = {
      ...passthroughKeys(server),
      ...(entry.command === null ? {} : { command: entry.command }),
      ...(entry.args.length === 0 ? {} : { args: entry.args }),
      ...(entry.env === null ? {} : { env: entry.env }),
    };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/**
 * OpenCode 2 keeps servers under `mcp.servers`; v1 kept them under `mcp`.
 * MCP Hub writes the v2 shape so the file no longer depends on OpenCode's
 * migration, and turns a numeric `timeout` into the v2 object.
 */
export function renderOpencode(servers: Array<{ name: string; server: HubServer }>): string {
  const mcp: Record<string, unknown> = {};
  for (const { name, server } of servers) {
    const entry = toRendered(server);
    const extras = passthroughKeys(server);
    const timeout = extras["timeout"];
    if (typeof timeout === "number") {
      extras["timeout"] = { catalog: timeout, execution: timeout };
    }
    mcp[name] = entry.remote
      ? {
          ...extras,
          type: "remote",
          url: entry.url,
          ...(entry.headers === null ? {} : { headers: entry.headers }),
        }
      : {
          ...extras,
          type: "local",
          command: [entry.command ?? "", ...entry.args],
          ...(entry.env === null ? {} : { environment: entry.env }),
        };
  }
  return `${JSON.stringify(
    { $schema: "https://opencode.ai/config.json", mcp: { servers: mcp } },
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

export function renderCodex(servers: Array<{ name: string; server: HubServer }>): string {
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

/** Harness configs MCP Hub does not write; read only to report name clashes. */
export interface ForeignSource {
  path: string;
  kind: HarnessKind;
}

interface Collision {
  server: string;
  path: string;
}

/** Harness configs a project may already carry, besides its own `.mcp.json`. */
function projectHarnessSources(projectPath: string): ForeignSource[] {
  return [
    { path: joinHost(projectPath, "opencode.json"), kind: "opencode" },
    { path: joinHost(projectPath, ".opencode", "opencode.json"), kind: "opencode" },
    { path: joinHost(projectPath, ".cursor", "mcp.json"), kind: "cursor" },
    { path: joinHost(projectPath, ".vscode", "mcp.json"), kind: "vscode" },
  ];
}

function foreignSources(home: string, projectPath: string | null): ForeignSource[] {
  const sources: ForeignSource[] = [
    { path: joinHost(home, ".config", "opencode", "opencode.json"), kind: "opencode" },
    { path: joinHost(home, ".claude.json"), kind: "claude" },
    { path: joinHost(home, ".cursor", "mcp.json"), kind: "cursor" },
  ];
  if (projectPath !== null) sources.push(...projectHarnessSources(projectPath));
  return sources;
}

function sortedRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** The connection a harness config entry describes, without harness-only keys. */
function connectionSignature(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  const url = entry["url"];
  if (typeof url === "string") {
    const headers = isRecord(entry["headers"]) ? entry["headers"] : {};
    return JSON.stringify({ url, headers: sortedRecord(headers) });
  }
  const rawCommand = entry["command"];
  const command = Array.isArray(rawCommand)
    ? rawCommand.filter((part): part is string => typeof part === "string")
    : typeof rawCommand === "string"
      ? [rawCommand, ...(Array.isArray(entry["args"]) ? entry["args"].filter((part): part is string => typeof part === "string") : [])]
      : null;
  if (command === null) return null;
  const env = isRecord(entry["environment"])
    ? entry["environment"]
    : isRecord(entry["env"])
      ? entry["env"]
      : {};
  return JSON.stringify({ command, env: sortedRecord(env) });
}

function ourSignature(server: HubServer, kind: HarnessKind): string | null {
  if (server.url !== undefined) {
    return connectionSignature({ url: server.url, headers: server.headers ?? {} });
  }
  return kind === "opencode"
    ? connectionSignature({
        command: [server.command ?? "", ...(server.args ?? [])],
        environment: server.env ?? {},
      })
    : connectionSignature({
        command: server.command,
        args: server.args,
        env: server.env ?? {},
      });
}

/** One MCP server as the page, the chip and the agent instruction see it. */
interface McpEntry {
  name: string;
  transport: "remote" | "command";
  scope: "host" | "project";
}

function formatInstructions(entries: McpEntry[], unresolved: string[]): string {
  const list = entries
    .map((entry) => `${entry.name} (${entry.transport}, ${entry.scope})`)
    .join(", ");
  const lines = [
    "## MCP servers",
    `MCP Hub resolves this workspace to: ${list}.`,
    "Each harness reads its own generated configuration. Claude Code user scope is an export at ~/.bb/mcp/export/claude-user-mcp.json and is not written automatically.",
  ];
  if (unresolved.length > 0) {
    lines.push(`Missing values: ${unresolved.join(", ")} — those references stay literal.`);
  }
  lines.push(
    "Run `bb mcp-hub status` before claiming a server is available or missing.",
  );
  return lines.join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    kimiCode: {
      type: "boolean",
      label: "Kimi Code",
      description:
        "Write ~/.kimi-code/mcp.json and the project .mcp.json that Kimi Code reads.",
      default: true,
    },
    claudeCode: {
      type: "boolean",
      label: "Claude Code",
      description:
        "Write the project .mcp.json Claude Code reads and the user-scope export ~/.bb/mcp/export/claude-user-mcp.json.",
      default: true,
    },
    opencode: {
      type: "boolean",
      label: "OpenCode",
      description:
        "Write MCP Hub's OpenCode config (host and project). Turn off to keep OpenCode entirely to yourself.",
      default: true,
    },
    cursor: {
      type: "boolean",
      label: "Cursor",
      description: "Write the Cursor export ~/.bb/mcp/export/cursor-mcp.json.",
      default: true,
    },
    codex: {
      type: "boolean",
      label: "Codex",
      description: "Write the Codex export ~/.bb/mcp/export/codex-config.toml.",
      default: true,
    },
    injectOpencode: {
      type: "boolean",
      label: "Inject MCP servers into OpenCode threads",
      description:
        "Point OPENCODE_CONFIG at MCP Hub's generated file so OpenCode threads start with the merged servers. Only used while OpenCode is enabled above.",
      default: true,
    },
  });

  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const homeByHost = new Map<string, string>();
  const opencodeReady = new Set<string>();

  // The agent instruction is resolved synchronously at session start, so the
  // merged state is remembered by workspace and refreshed off that path.
  const instructionCache = new Map<
    string,
    { at: number; text: string; entries: McpEntry[]; unresolved: string[] }
  >();
  const INSTRUCTION_TTL = 5 * 60_000;

  function cacheKey(hostId: string, projectPath: string | null): string {
    return `${hostId}\u0000${projectPath ?? ""}`;
  }

  function rememberPlan(
    hostId: string,
    projectPath: string | null,
    plan: Awaited<ReturnType<typeof buildPlan>>,
  ): McpEntry[] {
    const projectNames = new Set(Object.keys(plan.snap.project?.servers ?? {}));
    const entries: McpEntry[] = plan.servers.map(({ name, server }) => ({
      name,
      transport: server.url === undefined ? "command" : "remote",
      scope: projectNames.has(name) ? "project" : "host",
    }));
    instructionCache.set(cacheKey(hostId, projectPath), {
      at: Date.now(),
      text: entries.length === 0 ? "" : formatInstructions(entries, plan.unresolved),
      entries,
      unresolved: plan.unresolved,
    });
    return entries;
  }

  async function refreshInstructions(
    hostId: string,
    projectPath: string | null,
  ): Promise<void> {
    try {
      const plan = await buildPlan({ hostId, projectPath, hostName: "" }, false);
      rememberPlan(hostId, projectPath, plan);
    } catch {
      // A host that is offline keeps whatever the last successful plan said.
    }
  }

  async function snapshot(hostId: string, projectPath: string | null) {
    return hostClient.call(
      "snapshot",
      { projectPath, paths: [], foreignPaths: [] },
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
        { projectPath: null, paths: [opencodePath], foreignPaths: [] },
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
  const existsCache = new Map<string, { at: number; value: boolean }>();

  async function hostFileExists(hostId: string, path: string): Promise<boolean> {
    const key = `${hostId}\u0000${path}`;
    const hit = existsCache.get(key);
    const now = Date.now();
    if (hit !== undefined && now - hit.at < 30_000) return hit.value;
    try {
      const result = await hostClient.call(
        "snapshot",
        { projectPath: null, paths: [path], foreignPaths: [] },
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
    const current = await settings.get();
    if (!current.opencode || !current.injectOpencode) return [];
    let home = homeByHost.get(context.hostId);
    if (home === undefined) {
      await warmHost(context.hostId);
      home = homeByHost.get(context.hostId);
    }
    if (home === undefined) return [];
    const hostTarget = joinHost(home, ...OPENCODE_FILE);
    // The ready flag lives until restart; a hand-deleted file must drop it.
    if (
      opencodeReady.has(context.hostId) &&
      !(await hostFileExists(context.hostId, hostTarget))
    ) {
      opencodeReady.delete(context.hostId);
    }
    let target = hostTarget;
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

  /** Environment values as the target machine sees them, not this process. */
  async function hostEnvironment(hostId: string, names: string[]): Promise<VarMap> {
    if (names.length === 0) return {};
    try {
      const { values } = await hostClient.call(
        "envVars",
        { names },
        { hostId, signal: AbortSignal.timeout(10_000) },
      );
      const out: VarMap = {};
      for (const [name, value] of Object.entries(values)) {
        if (typeof value === "string") out[name] = value;
      }
      return out;
    } catch {
      // An offline or older host contributes no environment values.
      return {};
    }
  }

  async function buildPlan(
    target: ResolvedTarget,
    embedSecrets: boolean,
  ) {
    const snap = await snapshot(target.hostId, target.projectPath);
    // The merged list stays unexpanded: status and the CLI never echo a value
    // from mcp.local.json, only the `${VAR}` the user authored.
    const servers = mergeServers([snap.host, snap.project]);
    const hostServers = mergeServers([snap.host]);
    const authored = authoredServers(snap);
    const referenced = new Set<string>();
    for (const entry of [...servers, ...hostServers, ...authored]) {
      for (const name of referencedVars(entry.server)) referenced.add(name);
    }
    const env = await hostEnvironment(target.hostId, [...referenced]);
    const vars = collectVars([snap.hostLocal, snap.projectLocal], env);
    // Host-scope files must not inherit project servers, or one repository's
    // connectors would leak into every other project on the machine.
    const hostServersExpanded = expandServers(
      hostServers,
      collectVars([snap.hostLocal], env),
    );
    const serversExpanded = expandServers(servers, vars);
    // A committed project file must not carry values from mcp.local.json.
    const excludedServers = embedSecrets
      ? []
      : excludedBySecretVars(snap, servers, env);
    const selection = await settings.get();
    const targets: TargetSelection = {
      kimiCode: selection.kimiCode,
      claudeCode: selection.claudeCode,
      opencode: selection.opencode,
      cursor: selection.cursor,
      codex: selection.codex,
    };
    const projectAuthored = projectAuthoredFor(target.projectPath, snap.project);
    const { files, reaches } = renderTargets({
      home: snap.home,
      projectPath: target.projectPath,
      projectAuthored,
      projectLocal: snap.projectLocal !== null,
      targets,
      hostServers: hostServersExpanded,
      servers: serversExpanded,
      projectServers: serversExpanded.filter(
        (entry) => !excludedServers.includes(entry.name),
      ),
    });
    // Everything this scope could own; anything not written this time is a
    // leftover from another harness selection or an emptied project.
    const desired = new Set(files.map((file) => file.path));
    const candidates =
      target.projectPath === null
        ? hostTargetPaths(snap.home)
        : [
            ...hostTargetPaths(snap.home),
            ...projectTargetPaths(target.projectPath),
            legacyProjectIgnore(target.projectPath),
          ];
    const sources = foreignSources(snap.home, target.projectPath);
    const status = await hostClient.call(
      "snapshot",
      {
        projectPath: target.projectPath,
        paths: [...desired, ...candidates],
        foreignPaths: sources.map((source) => source.path),
      },
      { hostId: target.hostId, signal: AbortSignal.timeout(30_000) },
    );
    const removals = candidates.filter((path) => {
      if (desired.has(path)) return false;
      const state = status.files.find((candidate) => candidate.path === path);
      return state?.exists === true && state.owned;
    });

    return {
      files,
      reaches,
      removals,
      servers,
      authored,
      snap,
      status,
      envNames: new Set(Object.keys(env)),
      unresolved: collectUnresolved(servers, vars),
      excludedServers,
      projectAuthored,
      collisions: findCollisions(sources, status.foreign, serversExpanded),
    };
  }

  function collectUnresolved(
    servers: Array<{ name: string; server: HubServer }>,
    vars: VarMap,
  ): string[] {
    const missing = new Set<string>();
    for (const entry of servers) {
      for (const name of referencedVars(entry.server)) {
        if (vars[name] === undefined) missing.add(name);
      }
    }
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
    if (plan.projectAuthored === true && plan.excludedServers.length > 0) {
      lines.push(
        `Left out of the project .mcp.json because they use values from mcp.local.json or the host environment: ${plan.excludedServers.join(", ")}.`,
      );
    }
    if (plan.collisions.length > 0) {
      lines.push("Also configured in a harness file MCP Hub does not own:");
      for (const collision of plan.collisions) {
        lines.push(`  ${collision.server}  ${collision.path}`);
      }
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
    if (plan.projectAuthored === false) {
      lines.push(
        "Project files skipped: this project authors no servers in .bb/mcp.json.",
      );
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
    "  bb mcp-hub apply  [--host <id>] [--path <dir>] [--force] [--embed-secrets] [--json]",
  ].join("\n");

  type CliResult = { exitCode: number; stdout?: string; stderr?: string };

  /** CLI flags win over the thread's own context. */
  function cliTargetOptions(
    args: CliArgs,
    context: { threadId?: string; projectId?: string; cwd?: string },
  ): Parameters<typeof resolveTarget>[0] {
    const options: Parameters<typeof resolveTarget>[0] = {};
    if (args.host !== null) options.hostId = args.host;
    if (args.path !== null) options.path = args.path;
    if (args.host === null && args.path === null && context.cwd !== undefined) {
      options.cwd = context.cwd;
    }
    if (context.threadId !== undefined) options.threadId = context.threadId;
    if (context.projectId !== undefined) options.projectId = context.projectId;
    return options;
  }

  function statusResult(
    target: ResolvedTarget,
    plan: Awaited<ReturnType<typeof buildPlan>>,
    json: boolean,
  ): CliResult {
    if (!json) return { exitCode: 0, stdout: `${target.hostName}\n${describe(plan)}` };
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          host: target.hostName,
          hostId: target.hostId,
          projectPath: target.projectPath,
          projectAuthored: plan.projectAuthored,
          servers: plan.servers,
          unresolved: plan.unresolved,
          collisions: plan.collisions,
          removals: plan.removals,
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

  /** What apply would do with one target; never includes the file contents. */
  function plannedAction(
    plan: Awaited<ReturnType<typeof buildPlan>>,
    file: TargetFile,
    force: boolean,
  ): string {
    const state = plan.status.files.find((candidate) => candidate.path === file.path);
    if (state === undefined || !state.exists) return "create";
    if (state.sha256 === contentHash(file.content)) return "unchanged";
    if (state.owned) return "update";
    return force ? "backup+overwrite" : "skip (foreign)";
  }

  /** A stale target is removed only when MCP Hub owns it, or when forced. */
  function removalAction(
    plan: Awaited<ReturnType<typeof buildPlan>>,
    path: string,
    force: boolean,
  ): string {
    const state = plan.status.files.find((candidate) => candidate.path === path);
    const owned = state?.exists !== true || state.owned;
    if (owned) return "remove";
    return force ? "backup+remove" : "skip (foreign)";
  }

  function planResult(
    plan: Awaited<ReturnType<typeof buildPlan>>,
    json: boolean,
    force: boolean,
  ): CliResult {
    if (json) {
      // Contents may carry expanded secret values; the plan names actions only.
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          {
            files: plan.files.map((file) => ({
              path: file.path,
              action: plannedAction(plan, file, force),
            })),
            removals: plan.removals.map((path) => ({
              path,
              action: removalAction(plan, path, force),
            })),
          },
          null,
          2,
        ),
      };
    }
    const lines = plan.files.map(
      (file) => `${plannedAction(plan, file, force).padEnd(16)} ${file.path}`,
    );
    for (const path of plan.removals) {
      lines.push(`${removalAction(plan, path, force).padEnd(16)} ${path}`);
    }
    return { exitCode: 0, stdout: lines.join("\n") };
  }

  function applyWarnings(
    plan: Awaited<ReturnType<typeof buildPlan>>,
    failed: boolean,
    args: CliArgs,
  ): string[] {
    const warnings: string[] = [];
    if (failed && !args.force) {
      warnings.push("Some files were left alone; rerun with --force to take them over.");
    }
    if (plan.projectAuthored !== true) return warnings;
    if (plan.excludedServers.length > 0) {
      warnings.push(
        `Left out of the project .mcp.json because they use values from mcp.local.json or the host environment: ${plan.excludedServers.join(", ")}. Pass --embed-secrets to include them.`,
      );
    }
    if (args.embedSecrets) {
      warnings.push("The project .mcp.json now embeds expanded values; do not commit it.");
    }
    return warnings;
  }

  async function applyCommand(
    target: ResolvedTarget,
    plan: Awaited<ReturnType<typeof buildPlan>>,
    args: CliArgs,
  ): Promise<CliResult> {
    const results = await applyTarget(target, args.force, args.embedSecrets);
    const failed = results.some((result) => result.status === "foreign");
    const warnings = applyWarnings(plan, failed, args);
    return {
      exitCode: failed && !args.force ? 1 : 0,
      stdout: args.json
        ? JSON.stringify({ results }, null, 2)
        : formatResults(results),
      ...(warnings.length === 0 ? {} : { stderr: warnings.join("\n") }),
    };
  }

  async function applyTarget(
    target: ResolvedTarget,
    force: boolean,
    embedSecrets = false,
  ): Promise<ApplyResult[]> {
    const plan = await buildPlan(target, embedSecrets);
    rememberPlan(target.hostId, target.projectPath, plan);
    const applied = await hostClient.call(
      "apply",
      { files: plan.files, remove: plan.removals, force },
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
    // The composer's MCP count and the page both refetch on this signal.
    void bb.realtime.publish("mcp-hub/changed", { at: Date.now() });
    return applied.results;
  }

  /** Resolve one host (default: this machine) and the project's checkout on it. */
  async function projectTarget(
    hostId: string | null,
    projectId: string | null,
  ): Promise<ResolvedTarget> {
    const hosts = await bb.sdk.hosts.list({ includeCreating: false });
    const resolvedId =
      hostId ??
      (await bb.sdk.system.config()).primaryHostId ??
      hosts.find((host) => host.status === "connected")?.id;
    if (resolvedId === undefined || resolvedId === null) {
      throw new Error("No host to target.");
    }
    const host = hosts.find((candidate) => candidate.id === resolvedId);
    if (host === undefined) throw new Error(`Unknown host "${resolvedId}".`);
    if (host.status !== "connected") {
      throw new Error(`Host "${host.name}" is ${host.status}; connect it first.`);
    }
    let projectPath: string | null = null;
    if (projectId !== null) {
      const project = await bb.sdk.projects.get({ projectId });
      // Only a checkout on this host is editable from this host's page.
      const source = project.sources.find((candidate) => candidate.hostId === host.id);
      projectPath = source?.path ?? null;
    }
    return { hostId: host.id, projectPath, hostName: host.name };
  }

  /** One authored entry straight from a hub file, without a full plan. */
  async function authoredEntry(
    target: ResolvedTarget,
    scope: "host" | "project",
    name: string,
  ): Promise<HubServer | null> {
    const snap = await snapshot(target.hostId, target.projectPath);
    const servers = scope === "host" ? snap.host?.servers : snap.project?.servers;
    return servers?.[name] ?? null;
  }

  async function overviewFor(
    hostId: string | null,
    projectId: string | null,
  ): Promise<Overview> {
    const target = await projectTarget(hostId, projectId);
    const plan = await buildPlan(target, false);
    rememberPlan(target.hostId, target.projectPath, plan);
    const hostVars = readVars(plan.snap.hostLocal);
    const projectVars = readVars(plan.snap.projectLocal);
    const varState = new Map<string, Set<string>>();
    const rememberVar = (name: string): Set<string> => {
      const used = varState.get(name);
      if (used !== undefined) return used;
      const created = new Set<string>();
      varState.set(name, created);
      return created;
    };
    // Authored, not merged: a value stays manageable while its server is off or
    // shadowed by a project entry.
    for (const entry of plan.authored) {
      for (const name of referencedVars(entry.server)) rememberVar(name).add(entry.name);
    }
    for (const name of [...Object.keys(hostVars), ...Object.keys(projectVars)]) {
      rememberVar(name);
    }
    const hasValue = (value: string | undefined): boolean =>
      value !== undefined && value !== "";
    const vars = [...varState.entries()]
      .map(([name, used]) => {
        const host = hasValue(hostVars[name]);
        const project = hasValue(projectVars[name]);
        const environment = plan.envNames.has(name);
        return {
          name,
          usedBy: [...used],
          host,
          project,
          environment,
          resolved: host || project || environment,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    const [projects, hosts] = await Promise.all([
      bb.sdk.projects.list(),
      bb.sdk.hosts.list({ includeCreating: false }),
    ]);
    return {
      hostId: target.hostId,
      hostName: target.hostName,
      hosts: hosts.map((host) => ({
        id: host.id,
        name: host.name,
        status: host.status,
      })),
      home: plan.snap.home,
      projectId,
      projectPath: target.projectPath,
      projectAuthored: plan.projectAuthored,
      projects: projects.map((project) => {
        const source = project.sources.find(
          (candidate) => candidate.hostId === target.hostId,
        );
        return { id: project.id, name: project.name, path: source?.path ?? null };
      }),
      servers: plan.authored.map((entry) => ({
        name: entry.name,
        server: entry.server,
        scope: entry.scope,
        enabled: entry.enabled,
        materialized: entry.enabled ? (plan.reaches[entry.name] ?? []) : [],
        collisions: entry.enabled
          ? plan.collisions
              .filter((collision) => collision.server === entry.name)
              .map((collision) => collision.path)
          : [],
      })),
      vars,
      unresolved: plan.unresolved,
      targets: plan.files.map((file) => {
        const state = plan.status.files.find((candidate) => candidate.path === file.path);
        return {
          path: file.path,
          exists: state?.exists === true,
          owned: state?.owned === true,
        };
      }),
    };
  }

  bb.agents.configure((context) => {
    const projectPath = context.environment.path;
    const hit = instructionCache.get(cacheKey(context.host.id, projectPath));
    if (hit === undefined || Date.now() - hit.at > INSTRUCTION_TTL) {
      void refreshInstructions(context.host.id, projectPath);
    }
    return {
      // The plugin's manifest skill stays selected; only instructions change.
      tools: [],
      skills: ["mcp-hub"],
      ...(hit === undefined || hit.text === "" ? {} : { instructions: hit.text }),
    };
  });

  bb.rpc.register(uiContract, {
    overview: ({ hostId, projectId }) => overviewFor(hostId, projectId),
    async saveServer(input) {
      const target = await projectTarget(input.hostId, input.projectId);
      await hostClient.call(
        "saveServer",
        {
          scope: input.scope,
          projectPath: target.projectPath,
          name: input.name,
          previousName: input.previousName,
          server: input.server,
          vars: input.vars,
        },
        { hostId: target.hostId, signal: AbortSignal.timeout(30_000) },
      );
      return { results: await applyTarget(target, false) };
    },
    async importServers(input) {
      const target = await projectTarget(input.hostId, input.projectId);
      if (input.scope === "project" && target.projectPath === null) {
        throw new Error("This project has no checkout on the selected host.");
      }
      await hostClient.call(
        "importServers",
        {
          scope: input.scope,
          projectPath: target.projectPath,
          entries: input.entries,
        },
        { hostId: target.hostId, signal: AbortSignal.timeout(30_000) },
      );
      return { results: await applyTarget(target, false) };
    },
    async revealVar(input) {
      const target = await projectTarget(input.hostId, input.projectId);
      return hostClient.call(
        "revealVar",
        {
          scope: input.scope,
          projectPath: target.projectPath,
          name: input.name,
        },
        { hostId: target.hostId, signal: AbortSignal.timeout(30_000) },
      );
    },
    async projectSources(input) {
      const target = await projectTarget(input.hostId, input.projectId);
      if (target.projectPath === null) return { path: null, files: [] };
      const projectPath = target.projectPath;
      const manifest = joinHost(projectPath, ".mcp.json");
      // `.mcp.json` is also a target MCP Hub writes, so it is read here but not
      // reported as a collision source.
      const candidates: ForeignSource[] = [
        { path: manifest, kind: "claude" },
        ...projectHarnessSources(projectPath),
      ];
      const snapshot = await hostClient.call(
        "snapshot",
        {
          projectPath,
          paths: [manifest],
          foreignPaths: candidates.map((candidate) => candidate.path),
        },
        { hostId: target.hostId, signal: AbortSignal.timeout(30_000) },
      );
      // A project `.mcp.json` MCP Hub wrote is its own output, not a source.
      const manifestOwned =
        snapshot.files.find((file) => file.path === manifest)?.owned === true;
      const files = candidates.flatMap((candidate) => {
        if (candidate.path === manifest && manifestOwned) return [];
        const file = snapshot.foreign.find((entry) => entry.path === candidate.path);
        if (file === undefined || !file.exists) return [];
        const servers = serverEntries(candidate.kind, file.json);
        const entries =
          servers === null
            ? []
            : Object.entries(servers).flatMap(([name, raw]) => {
                const server = serverFromEntry(raw);
                if (server === null || !SERVER_NAME_PATTERN.test(name)) return [];
                return [{ name, server }];
              });
        if (file.error === null && entries.length === 0) return [];
        return [
          {
            path: candidate.path,
            kind: candidate.kind,
            error: file.error,
            servers: entries,
          },
        ];
      });
      return { path: projectPath, files };
    },
    async deleteServer(input) {
      const target = await projectTarget(input.hostId, input.projectId);
      await hostClient.call(
        "deleteServer",
        { scope: input.scope, projectPath: target.projectPath, name: input.name },
        { hostId: target.hostId, signal: AbortSignal.timeout(30_000) },
      );
      return { results: await applyTarget(target, false) };
    },
    async setVar(input) {
      const target = await projectTarget(input.hostId, input.projectId);
      await hostClient.call(
        "setVar",
        {
          scope: input.scope,
          projectPath: target.projectPath,
          name: input.name,
          value: input.value,
        },
        { hostId: target.hostId, signal: AbortSignal.timeout(30_000) },
      );
      return { results: await applyTarget(target, false) };
    },
    async apply({ hostId, projectId, force }) {
      const target = await projectTarget(hostId, projectId);
      return { results: await applyTarget(target, force) };
    },
    async setEnabled({ hostId, projectId, scope, name, enabled }) {
      const target = await projectTarget(hostId, projectId);
      const current = await authoredEntry(target, scope, name);
      if (current === null) throw new Error(`Unknown ${scope} server "${name}".`);
      const server: HubServer = { ...current };
      if (enabled) delete server.enabled;
      else server.enabled = false;
      await hostClient.call(
        "saveServer",
        {
          scope,
          projectPath: target.projectPath,
          name,
          previousName: name,
          server,
          vars: null,
        },
        { hostId: target.hostId, signal: AbortSignal.timeout(30_000) },
      );
      return { results: await applyTarget(target, false) };
    },
    async threadTarget({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId === null) {
        return { hostId: null, projectId: thread.projectId ?? null };
      }
      const environment = await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });
      return { hostId: environment.hostId, projectId: thread.projectId ?? null };
    },
  });

  bb.cli.register({
    name: "mcp-hub",
    summary: "Merge MCP servers from host and project hub files into each harness",
    commands: [
      { name: "status", summary: "Show merged servers and target file state", usage: "bb mcp-hub status [--host <id>] [--path <dir>]" },
      { name: "plan", summary: "Show what apply would write", usage: "bb mcp-hub plan [--host <id>] [--path <dir>]" },
      { name: "apply", summary: "Write the generated files", usage: "bb mcp-hub apply [--host <id>] [--path <dir>] [--force] [--embed-secrets]" },
    ],
    async run(argv, context) {
      const args = parseCliArgs(argv);
      if (args.invalid) return { exitCode: 1, stderr: usage };
      if (args.command === null) return { exitCode: 0, stdout: usage };
      if (args.path !== null && !isAbsoluteHostPath(args.path)) {
        return { exitCode: 1, stderr: "--path must be an absolute path" };
      }

      const target = await resolveTarget(cliTargetOptions(args, context));

      const plan = await buildPlan(target, args.embedSecrets);
      if (args.command === "status") return statusResult(target, plan, args.json);
      if (args.command === "plan") return planResult(plan, args.json, args.force);
      return applyCommand(target, plan, args);
    },
  });
}











