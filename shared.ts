// Parsing shared by the server entry and the page.
//
// A hub file, the agent CLI and the paste/import dialogs all answer the same
// questions: which keys MCP Hub owns, where `${VAR}` appears, and how a harness
// writes one server. Keeping one answer here stops those from drifting apart.
import type { HubServer } from "./contract.js";

/** Keys MCP Hub renders itself; everything else passes through to the harness. */
export const MANAGED_SERVER_KEYS = [
  "url",
  "headers",
  "command",
  "args",
  "env",
  "enabled",
] as const;

/** Keys a harness entry uses for transport details rather than passthrough. */
export const MODELLED_KEYS = new Set<string>([
  ...MANAGED_SERVER_KEYS,
  "type",
  "environment",
  "disabled",
]);

export const VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/gu;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Values from a hub file's `vars` object; anything but a string is ignored. */
export function readVars(file: unknown): Record<string, string> {
  if (!isRecord(file)) return {};
  const vars = file["vars"];
  if (!isRecord(vars)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Every `${VAR}` name a value references, at any depth. */
export function referencedVars(value: unknown): string[] {
  const names = new Set<string>();
  const scan = (item: unknown) => {
    if (typeof item === "string") {
      for (const match of item.matchAll(VAR_PATTERN)) names.add(match[1]);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) scan(child);
      return;
    }
    if (isRecord(item)) {
      for (const child of Object.values(item)) scan(child);
    }
  };
  scan(value);
  return [...names];
}

/** Shell-ish split: quotes group words, so a pasted command keeps its args. */
export function splitCommand(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current !== "") parts.push(current);
  return parts;
}

export type HarnessKind = "opencode" | "claude" | "cursor" | "vscode";

/**
 * OpenCode nests servers under `mcp.servers` (v2) or `mcp` (v1, with a possible
 * `timeout` sibling); Claude Code, Cursor and Kimi Code use `mcpServers`; VS
 * Code uses `servers`. `auto` reads whichever a pasted snippet uses.
 */
export function serverEntries(
  kind: HarnessKind | "auto",
  json: unknown,
): Record<string, unknown> | null {
  if (!isRecord(json)) return null;
  const nested = () => {
    const mcp = json["mcp"];
    if (!isRecord(mcp)) return null;
    const servers = mcp["servers"];
    if (isRecord(servers)) return servers;
    const flat = Object.fromEntries(
      Object.entries(mcp).filter(
        ([key, value]) => key !== "timeout" && isRecord(value),
      ),
    );
    return Object.keys(flat).length === 0 ? null : flat;
  };
  const shared = () => {
    const servers = json["mcpServers"];
    return isRecord(servers) ? servers : null;
  };
  const vscode = () => {
    const servers = json["servers"];
    return isRecord(servers) ? servers : null;
  };
  if (kind === "opencode") return nested();
  if (kind === "vscode") return vscode();
  if (kind === "claude" || kind === "cursor") return shared();
  return shared() ?? nested() ?? vscode();
}

/** One harness entry (`mcpServers`, `mcp.servers`, `servers`) as a hub server. */
export function serverFromEntry(
  entry: unknown,
  options: { splitCommand?: boolean } = {},
): HubServer | null {
  if (!isRecord(entry)) return null;
  const passthrough = Object.fromEntries(
    Object.entries(entry).filter(([key]) => !MODELLED_KEYS.has(key)),
  );
  const enabled = entry["disabled"] !== true && entry["enabled"] !== false;
  const headers: Record<string, string> | null = isRecord(entry["headers"])
    ? Object.fromEntries(
        Object.entries(entry["headers"]).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string",
        ),
      )
    : null;
  if (typeof entry["url"] === "string" && entry["url"] !== "") {
    return {
      ...passthrough,
      url: entry["url"],
      ...(entry["type"] === "sse" ? { type: "sse" } : {}),
      ...(headers === null ? {} : { headers }),
      ...(enabled ? {} : { enabled: false }),
    };
  }
  const rawCommand = entry["command"];
  const argv = Array.isArray(rawCommand)
    ? rawCommand.filter((part): part is string => typeof part === "string")
    : typeof rawCommand === "string"
      ? options.splitCommand === true
        ? splitCommand(rawCommand)
        : [rawCommand]
      : [];
  const command = argv[0];
  if (command === undefined || command === "") return null;
  const args = [
    ...argv.slice(1),
    ...(Array.isArray(entry["args"])
      ? entry["args"].filter((part): part is string => typeof part === "string")
      : []),
  ];
  const rawEnv = isRecord(entry["environment"])
    ? entry["environment"]
    : isRecord(entry["env"])
      ? entry["env"]
      : {};
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(rawEnv).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    ),
  );
  return {
    ...passthrough,
    command,
    ...(args.length === 0 ? {} : { args }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(enabled ? {} : { enabled: false }),
  };
}
