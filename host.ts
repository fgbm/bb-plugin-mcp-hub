// Host entry: reads the MCP Hub configuration files and writes generated
// artifacts on this machine.
//
// Ownership matters here. Every file the plugin writes is recorded with its
// SHA-256 in ~/.bb/mcp/state.json; a file that exists without a matching record
// belongs to the user and is never overwritten unless the caller passes force.
// A forced overwrite saves a timestamped copy under ~/.bb/mcp/backups first.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  hostContract,
  hubServerSchema,
  ownedStateSchema,
  type ApplyResult,
  type HubFile,
  type OwnedState,
} from "./contract.js";
import { isRecord, readVars } from "./shared.js";

function hubDir(home: string): string {
  return join(home, ".bb", "mcp");
}

/** The hub file a scope reads: host files under ~/.bb, project files under <repo>/.bb. */
function hubFilePath(
  home: string,
  projectPath: string | null,
  scope: "host" | "project",
  local: boolean,
): string {
  const file = local ? "mcp.local.json" : "mcp.json";
  if (scope === "host") return join(home, ".bb", file);
  if (projectPath === null) throw new Error("A project scope needs a project path.");
  return join(projectPath, ".bb", file);
}

function readRawObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readJson(path);
  if (!isRecord(raw)) {
    throw new Error(`${path} is not a JSON object; refuse to overwrite it.`);
  }
  return raw;
}

function writeHub(path: string, raw: Record<string, unknown>): void {
  writeAtomic(path, `${JSON.stringify(raw, null, 2)}\n`, 0o600);
}

/** Values live next to the scope's hub file; empty strings remove a name. */
function writeVars(
  home: string,
  projectPath: string | null,
  scope: "host" | "project",
  values: Record<string, string>,
): void {
  const path = hubFilePath(home, projectPath, scope, true);
  const raw = readRawObject(path);
  const vars: Record<string, unknown> = { ...readVars(raw) };
  for (const [name, value] of Object.entries(values)) {
    if (value === "") delete vars[name];
    else vars[name] = value;
  }
  writeHub(path, { ...raw, vars });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readHubFile(path: string): HubFile | null {
  const raw = readJson(path);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const servers = isRecord(raw) ? raw["servers"] : null;
  // A hand-edited entry with a wrong shape must not fail the host RPC output
  // and take status/apply/overview down with it; keep the entries that parse.
  const valid = Object.entries(isRecord(servers) ? servers : {}).filter(
    ([, entry]) => hubServerSchema.safeParse(entry).success,
  );
  return {
    ...(raw as Record<string, unknown>),
    servers: Object.fromEntries(valid),
  } as HubFile;
}

function readState(home: string): OwnedState {
  const raw = readJson(join(hubDir(home), "state.json"));
  const parsed = ownedStateSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { files: {} };
}

function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.bb-tmp-${String(process.pid)}`;
  writeFileSync(temp, content, mode === undefined ? undefined : { mode });
  renameSync(temp, path);
}

/** A harness config can hold a lot of unrelated state; do not ship megabytes. */
const MAX_FOREIGN_BYTES = 1024 * 1024;

function readForeign(path: string): {
  path: string;
  exists: boolean;
  json: unknown;
  error: string | null;
} {
  if (!existsSync(path)) return { path, exists: false, json: null, error: null };
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return { path, exists: true, json: null, error: "Not a regular file." };
    }
    if (stat.size > MAX_FOREIGN_BYTES) {
      return { path, exists: true, json: null, error: "File is too large to inspect." };
    }
    return {
      path,
      exists: true,
      json: JSON.parse(readFileSync(path, "utf8")) as unknown,
      error: null,
    };
  } catch (error) {
    return {
      path,
      exists: true,
      json: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    snapshot: ({ projectPath, paths, foreignPaths }) => {
      const home = homedir();
      const state = readState(home);
      return {
        home,
        host: readHubFile(join(home, ".bb", "mcp.json")),
        hostLocal: readHubFile(join(home, ".bb", "mcp.local.json")),
        project:
          projectPath === null
            ? null
            : readHubFile(join(projectPath, ".bb", "mcp.json")),
        projectLocal:
          projectPath === null
            ? null
            : readHubFile(join(projectPath, ".bb", "mcp.local.json")),
        state,
        files: paths.map((path) => {
          const exists = existsSync(path);
          if (!exists) return { path, exists, sha256: null, owned: false };
          const stat = statSync(path);
          if (!stat.isFile()) return { path, exists: true, sha256: null, owned: false };
          const hash = sha256(readFileSync(path, "utf8"));
          return {
            path,
            exists: true,
            sha256: hash,
            owned: state.files[path]?.sha256 === hash,
          };
        }),
        foreign: foreignPaths.map(readForeign),
      };
    },
    apply: ({ files, remove, force }) => {
      const home = homedir();
      const state = readState(home);
      // A workspace that is gone leaves owned paths behind; drop them so the
      // state file describes this machine, not a deleted checkout.
      for (const path of Object.keys(state.files)) {
        if (!existsSync(path)) delete state.files[path];
      }
      const results: ApplyResult[] = [];
      const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
      const backup = (targetPath: string) => {
        const target = join(
          hubDir(home),
          "backups",
          stamp,
          targetPath.replace(/^[A-Za-z]:/u, "").replace(/[/\\]+/gu, "_"),
        );
        writeAtomic(target, readFileSync(targetPath, "utf8"), 0o600);
      };
      try {
        for (const file of files) {
          const hash = sha256(file.content);
          const exists = existsSync(file.path);
          const current = exists ? sha256(readFileSync(file.path, "utf8")) : null;
          const owned = exists && state.files[file.path]?.sha256 === current;
          if (exists && current === hash) {
            results.push({ path: file.path, status: "unchanged", message: null });
            state.files[file.path] = { sha256: hash, writtenAt: Date.now() };
            continue;
          }
          if (exists && !owned && !force) {
            results.push({
              path: file.path,
              status: "foreign",
              message:
                "File exists and was not written by MCP Hub; rerun with --force to back it up and take it over.",
            });
            continue;
          }
          if (exists && current !== null) {
            backup(file.path);
          }
          writeAtomic(file.path, file.content, file.mode);
          state.files[file.path] = { sha256: hash, writtenAt: Date.now() };
          results.push({ path: file.path, status: "written", message: null });
        }
        // A target MCP Hub used to write and no longer does. Deleting it needs the
        // same ownership proof as overwriting: a hand-edited file stays put
        // unless the caller forces the removal, which backs it up first.
        for (const path of remove) {
          if (!existsSync(path)) {
            delete state.files[path];
            continue;
          }
          const current = sha256(readFileSync(path, "utf8"));
          const owned = state.files[path]?.sha256 === current;
          if (!owned && !force) {
            results.push({
              path,
              status: "foreign",
              message:
                "MCP Hub no longer targets this file but does not own its current content; left in place.",
            });
            continue;
          }
          if (!owned) backup(path);
          rmSync(path);
          delete state.files[path];
          results.push({
            path,
            status: "removed",
            message: owned ? null : "Backed up before the forced removal.",
          });
        }
        return { results };
      } finally {
        // Persist after a partial failure too: files already written must not
        // turn into "foreign" on the next apply.
        mkdirSync(hubDir(home), { recursive: true });
        writeAtomic(
          join(hubDir(home), "state.json"),
          JSON.stringify(state, null, 2),
          0o600,
        );
      }
    },
    saveServer: ({ scope, projectPath, name, previousName, server, vars }) => {
      const home = homedir();
      const path = hubFilePath(home, projectPath, scope, false);
      const raw = readRawObject(path);
      const servers = isRecord(raw["servers"]) ? { ...raw["servers"] } : {};
      if (previousName !== null && previousName !== name) delete servers[previousName];
      // The page sends the whole entry, including harness extras it edits under
      // Advanced options, so replacing it is what keeps those keys in sync.
      servers[name] = { ...server };
      writeHub(path, { ...raw, servers });
      if (vars !== null && Object.keys(vars).length > 0) {
        writeVars(home, projectPath, scope, vars);
      }
      return { path };
    },
    importServers: ({ scope, projectPath, entries }) => {
      const home = homedir();
      const path = hubFilePath(home, projectPath, scope, false);
      const raw = readRawObject(path);
      const servers = isRecord(raw["servers"]) ? { ...raw["servers"] } : {};
      for (const entry of entries) servers[entry.name] = entry.server;
      writeHub(path, { ...raw, servers });
      return { path };
    },
    revealVar: ({ scope, projectPath, name }) => {
      const home = homedir();
      const value = readVars(readRawObject(hubFilePath(home, projectPath, scope, true)))[name];
      return { value: value ?? null };
    },
    envVars: ({ names }) => ({
      values: Object.fromEntries(
        names.map((name) => [name, process.env[name] ?? null]),
      ),
    }),
    deleteServer: ({ scope, projectPath, name }) => {
      const home = homedir();
      const path = hubFilePath(home, projectPath, scope, false);
      const raw = readRawObject(path);
      const servers = isRecord(raw["servers"]) ? { ...raw["servers"] } : {};
      delete servers[name];
      writeHub(path, { ...raw, servers });
      return { path };
    },
    setVar: ({ scope, projectPath, name, value }) => {
      const home = homedir();
      writeVars(home, projectPath, scope, { [name]: value ?? "" });
      return { path: hubFilePath(home, projectPath, scope, true) };
    },
  },
});
