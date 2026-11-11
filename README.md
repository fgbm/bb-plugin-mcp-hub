# MCP Hub

One source of truth for MCP servers, rendered into the files each coding
harness already reads. Host scope and project scope, with secrets kept out of
version control.

## Why

Every agent CLI keeps its own MCP configuration, and bb hands an ACP agent only
its own dynamic-tools bridge. The same context7 or Bitrix24 connector therefore
has to be re-added per harness, and the copies drift. MCP Hub keeps a single
host file and a single project file, then writes the harness files from them.

## Where things live

| Scope   | File                                   | Committed |
| ------- | -------------------------------------- | --------- |
| host    | `~/.bb/mcp.json`                       | no        |
| host    | `~/.bb/mcp.local.json` (values)        | no        |
| project | `<repo>/.bb/mcp.json`                  | yes       |
| project | `<repo>/.bb/mcp.local.json` (values)   | no        |

Project entries override host entries with the same name. `"enabled": false`
removes a server from the generated output.

```json
{
  "servers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": { "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}" }
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

`${NAME}` is expanded from `mcp.local.json` first, then from the host process
environment. Unresolved names are reported by `bb mcp-hub status`.

## What gets written

| Target | File | Automatic |
| ------ | ---- | --------- |
| Kimi Code (host) | `~/.kimi-code/mcp.json` | yes |
| Kimi Code, Claude Code (project) | `<repo>/.mcp.json` | yes |
| OpenCode (host) | `~/.bb/mcp/opencode.json`, injected as `OPENCODE_CONFIG` | yes |
| OpenCode (project) | `<repo>/.bb/mcp/opencode.json` + `.gitignore`, injected instead of the host file | yes |
| Cursor | `~/.bb/mcp/export/cursor-mcp.json` | copy into `~/.cursor/mcp.json` |
| Codex | `~/.bb/mcp/export/codex-config.toml` | append to `~/.codex/config.toml` |

The OpenCode project file may carry values from `mcp.local.json` because it is
never committed: apply also writes `<repo>/.bb/mcp/.gitignore` with `*`, so git
ignores the whole directory.

MCP Hub never merges into a harness file that also holds other settings. A file
it did not write is reported as `foreign` and left alone; `--force` backs it up
under `~/.bb/mcp/backups/` and takes it over. Every written file is tracked by
SHA-256 in `~/.bb/mcp/state.json`, so a hand-edited file stops being managed
instead of being silently overwritten.

The generated files are mode `0600`. The project `.mcp.json` skips servers whose
values come from `mcp.local.json` — pass `--embed-secrets` when the repo is
private. The OpenCode project file under `.bb/mcp/` is git-ignored by the
generated `.gitignore` and may keep those values.

## Commands

```
bb mcp-hub status [--host <id>] [--path <dir>] [--json]
bb mcp-hub plan   [--host <id>] [--path <dir>]
bb mcp-hub apply  [--host <id>] [--path <dir>] [--force] [--embed-secrets]
```

Without `--host`/`--path` the command targets the current thread's host and
workspace. `bb plugin config mcp-hub set injectOpencode false` stops the
OpenCode environment injection.

## Requirements

bb 0.49 or newer. Nothing else: the plugin writes plain files on each host and
uses the Kimi Code, Claude Code and OpenCode configuration formats they already
document.

## stdio servers over npx

`npx -y <package>` resolves and downloads on first use: a cold start can take
minutes and a changed spec string (`@latest` → `@0.0.85`) starts a new cache
entry, so the agent runs a turn without the server's tools until it connects.
Pin the version and warm the cache once per host:

```
npx -y @playwright/mcp@0.0.85 --version
```

Afterwards the same server answers its MCP handshake in about two seconds. A
global install (`npm i -g @playwright/mcp`, then `command: "playwright-mcp"`)
skips npx entirely.
