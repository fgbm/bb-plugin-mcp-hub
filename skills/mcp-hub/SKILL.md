---
name: mcp-hub
description: Add, change or inspect MCP servers for every coding harness from one host-level or project-level file. Use when the user asks to add an MCP server, to make the same connector available in Kimi Code, Claude Code, OpenCode, Cursor or Codex, or to see which MCP servers a machine has.
---

# MCP Hub

MCP servers are authored once, then written into the files each harness reads.

## Inspect

```
bb mcp-hub status --json
```

Shows the merged server list, any unresolved `${VAR}` names, and the state of
every target file (`owned`, `foreign`, `missing`).

## Add or change a server

1. Edit the host file `~/.bb/mcp.json` (all projects on the machine) or the
   project file `<repo>/.bb/mcp.json` (this repository only).
2. Put values such as API keys in the sibling `mcp.local.json` under `vars` and
   reference them as `${NAME}`. The project local file is git-ignored by apply.
3. Run `bb mcp-hub apply` and report which files changed.

The page owns the same files: **Secrets** lists every name with its scope
(host/project/environment) and lets the user add, inspect, replace and clear a
value; **Import from files** copies servers already present in `.mcp.json`,
`opencode.json`, `.cursor/mcp.json` or `.vscode/mcp.json` into the project hub
file. Prefer editing the hub files with the page or by hand over duplicating a
harness config.

```json
{
  "servers": {
    "context7": { "url": "https://mcp.context7.com/mcp" },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}
```

## Rules

- Host files are rendered from host scope only; project files add or override
  servers by name.
- Project files (`<repo>/.mcp.json`, `<repo>/.bb/mcp/`) are only written when
  `<repo>/.bb/mcp.json` defines at least one server.
- `"enabled": false` removes a server.
- Never edit a generated file by hand and expect it to persist: the next apply
  replaces it. Change the hub file instead.
- A file marked `foreign` belongs to the user. Do not pass `--force` without
  asking.
- `status` lists server names that also exist in a harness config MCP Hub does
  not own (your OpenCode global config, `~/.cursor/mcp.json`, `~/.claude.json`).
  Which definition wins depends on the harness and the file; report the clash,
  do not hide it.
- Claude Code user scope lives in `~/.claude.json`, which MCP Hub leaves alone;
  `~/.bb/mcp/export/claude-user-mcp.json` is the copy to add there.
- `~/.bb/mcp/export/cursor-mcp.json` and `codex-config.toml` are for harnesses
  MCP Hub does not write to directly; hand them to the user when relevant.
- `status --json` lists servers as authored (`${VAR}` intact), never the values
  from `mcp.local.json`.
- Harnesses are chosen in the plugin settings (Kimi Code, Claude Code, OpenCode,
  Cursor, Codex). A disabled harness is not written, and a file MCP Hub wrote for
  it earlier is removed on the next apply — so do not report it as configured.
