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
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  hostContract,
  ownedStateSchema,
  type ApplyResult,
  type HubFile,
  type OwnedState,
} from "./contract.js";

function hubDir(home: string): string {
  return join(home, ".bb", "mcp");
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
  const servers = (raw as { servers?: unknown }).servers;
  return {
    ...(raw as Record<string, unknown>),
    servers: typeof servers === "object" && servers !== null && !Array.isArray(servers)
      ? servers
      : {},
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

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    snapshot: ({ projectPath, paths }) => {
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
      };
    },
    apply: ({ files, force }) => {
      const home = homedir();
      const state = readState(home);
      const results: ApplyResult[] = [];
      const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
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
          const backup = join(
            hubDir(home),
            "backups",
            stamp,
            file.path.replace(/^[A-Za-z]:/u, "").replace(/[/\\]+/gu, "_"),
          );
          writeAtomic(backup, readFileSync(file.path, "utf8"));
        }
        writeAtomic(file.path, file.content, file.mode);
        state.files[file.path] = { sha256: hash, writtenAt: Date.now() };
        results.push({ path: file.path, status: "written", message: null });
      }
      mkdirSync(hubDir(home), { recursive: true });
      writeAtomic(join(hubDir(home), "state.json"), JSON.stringify(state, null, 2), 0o600);
      return { results };
    },
  },
});
