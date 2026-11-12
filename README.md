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

`${NAME}` is expanded from `mcp.local.json` first, then from the environment of
the target host itself (the machine the files are written on), not from the bb
server. Unresolved names are reported by `bb mcp-hub status`.

## What gets written

| Target | File | Automatic |
| ------ | ---- | --------- |
| Kimi Code (host) | `~/.kimi-code/mcp.json` | yes |
| Kimi Code, Claude Code (project) | `<repo>/.mcp.json` | yes, when the project has servers |
| OpenCode (host) | `~/.bb/mcp/opencode.json`, injected as `OPENCODE_CONFIG` | yes |
| OpenCode (project) | `<repo>/.bb/mcp/opencode.json` + `.gitignore`, injected instead of the host file | yes, when the project has servers |
| Claude Code (host) | `~/.bb/mcp/export/claude-user-mcp.json` | copy into `~/.claude.json` under `mcpServers`, or add it with `claude mcp add-json` at user scope |
| Cursor | `~/.bb/mcp/export/cursor-mcp.json` | copy into `~/.cursor/mcp.json` |
| Codex | `~/.bb/mcp/export/codex-config.toml` | append to `~/.codex/config.toml` |

Claude Code keeps user-scope servers inside `~/.claude.json`, the same file that
holds its session state, so MCP Hub does not merge into it: it writes the export
and leaves that one step to you. Project scope needs nothing extra: the Claude
Code provider reads `<repo>/.mcp.json`.

OpenCode files use the v2 shape (`mcp.servers`, `type`, optional
`disabled`/`timeout`), so they no longer depend on OpenCode migrating a v1 file.
A numeric `timeout` written in a hub file becomes `{ "catalog": n, "execution": n }`.

Project files are only written when `<repo>/.bb/mcp.json` defines at least one
server. A repository that authors nothing gets no committed `.mcp.json` and no
`.bb/mcp/` directory just because someone ran `apply` there. When a project stops
authoring servers, the next `apply` deletes the files MCP Hub itself wrote for it
(a file someone edited by hand is left alone and reported as `foreign`).

## Hosts

Everything is per host: `~/.bb/mcp.json`, `mcp.local.json`, the generated files,
the ownership state and the backups all live on the machine they describe. The
page has a host picker, `bb mcp-hub … --host <id>` targets one explicitly, and a
thread always resolves against the host its environment runs on — including the
agent instructions and the composer counter.

The OpenCode project file may carry values from `mcp.local.json` because it is
never committed: apply also writes `<repo>/.bb/.gitignore` with
`mcp.local.json` and `mcp/`, so the values and the generated files stay out of
git while `.bb/mcp.json` remains committable.

MCP Hub never merges into a harness file that also holds other settings. A file
it did not write is reported as `foreign` and left alone; `--force` backs it up
under `~/.bb/mcp/backups/` and takes it over. Every written file is tracked by
SHA-256 in `~/.bb/mcp/state.json`, so a hand-edited file stops being managed
instead of being silently overwritten. Records whose file is gone are dropped on
the next `apply`.

A server name can already exist in a harness file MCP Hub does not own — your
own OpenCode global config, `~/.cursor/mcp.json`, the user-scope half of
`~/.claude.json`. Which definition wins depends on the harness and the file, so
`status` lists every such name with the file it collides with, and `status
--json` returns a `collisions` array. Names that describe the same connection
are not reported.

`status --json` never echoes a value from `mcp.local.json`: servers are listed as
authored, with `${VAR}` references intact, and `unresolved` names what has no
value yet.

The generated files are mode `0600`. The project `.mcp.json` skips servers whose
values come from `mcp.local.json` — pass `--embed-secrets` when the repo is
private. The OpenCode project file under `.bb/mcp/` is git-ignored by the
generated `.gitignore` and may keep those values.

## Page and composer counter

The **MCP** page in the sidebar lists every authored server for the host and the
selected project, edits it (remote URL or local command, args, env, headers),
sets values for `${VAR}` references, and shows the state of each generated file.
Every change applies immediately; a foreign file still needs **Take over**.

The editor carries the scope as a field (**Available in every project** or **Only
this project**), so moving a server between hub files is one save. It also takes
pasted input: **Import JSON** fills the form from an `mcpServers` snippet, **Paste
whole command** splits a command line into arguments, and **Paste .env** /
**Paste headers** merge clipboard lists into the key/value rows. Request headers
and environment variables are edited as key/value rows, not as free text; a name
that appears twice is rejected. A remote server also picks **HTTP** or **SSE**;
the SSE type is kept in the shared `.mcp.json` shape. Harness options MCP Hub
does not model (`timeout`, `oauth`, ...) live under **Advanced options** as JSON
and are passed through untouched. Under each server the page shows which
harnesses actually contain it.

**Import JSON** understands the shapes harnesses use: `mcpServers` (Claude Code,
Cursor, Kimi Code), `mcp.servers` (OpenCode v2), `mcp` (OpenCode v1), `servers`
(VS Code) and a single bare entry.

**Import from files** on the project tab reads the configs the repository already
carries — `.mcp.json`, `opencode.json`, `.opencode/opencode.json`,
`.cursor/mcp.json`, `.vscode/mcp.json` — and copies the selected servers into
`<repo>/.bb/mcp.json`. A pre-existing `.mcp.json` is a file MCP Hub does not own,
so it stays as written until **Take over**. When the selected project already
configures servers in one of those files, the page shows a banner with the count
and a **Review and import** action, so they are visible before anyone opens the
project tab. Imported values are copied verbatim; when a header or environment
name looks like a token, the dialog warns that it will land in the committed hub
file.

**Secrets** lists every `${VAR}`, including names used only by a disabled server
or not used by any server, and shows whether a value lives in the host file, the
project file or the process environment. **Add secret** creates a value ahead of
time; **Edit** reads the stored value on request, so it can be reviewed,
replaced or cleared per scope. A server that references `${VAR}` also shows the
missing values right in its editor, and they are saved together with the server.
Values are only sent to the page when you open a secret and are stored with mode
`0600`; `status --json` and the agent instructions never include them.

The composer toolbar carries a small counter before the voice button. It opens
the same list as a menu with an on/off switch per server, scoped to the thread's
project. Disabling writes `"enabled": false` and re-applies; the entry stays in
the list so it can be turned back on.

## Settings

Each harness can be turned off in **Settings → Plugins → MCP Hub**; a disabled
harness gets no file, and a file it wrote earlier is deleted on the next apply.

| Setting | Writes |
| ------- | ------ |
| Kimi Code | `~/.kimi-code/mcp.json`, project `.mcp.json` |
| Claude Code | project `.mcp.json`, `~/.bb/mcp/export/claude-user-mcp.json` |
| OpenCode | host and project OpenCode config |
| Cursor | `~/.bb/mcp/export/cursor-mcp.json` |
| Codex | `~/.bb/mcp/export/codex-config.toml` |
| Inject into OpenCode threads | `OPENCODE_CONFIG` for OpenCode sessions; only used while OpenCode is on |

The project `.mcp.json` is shared by Kimi Code and Claude Code, so it is written
while either of them is on.

## Commands

```
bb mcp-hub status [--host <id>] [--path <dir>] [--json]
bb mcp-hub plan   [--host <id>] [--path <dir>] [--json] [--force]
bb mcp-hub apply  [--host <id>] [--path <dir>] [--force] [--embed-secrets]
```

`plan --json` lists each target with its action (`create`, `update`, `skip
(foreign)`, ...) and the removals; it never prints file contents, because those
can contain expanded secret values.

Without `--host`/`--path` the command targets the current thread's host and
workspace. `bb plugin config mcp-hub set injectOpencode false` stops the
OpenCode environment injection.

## Tests

`npm test` runs the vitest suite; `npm run test:coverage` writes
`coverage/lcov.info` for the `crap-metric` skill. The suite currently covers the
pure modules (`shared.ts`, `contract.ts`) and the server renderers
(`server.ts`); the GUI (`app.tsx`) and the host handlers (`host.ts`) have no
tests yet.

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
