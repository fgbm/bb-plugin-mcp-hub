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
   reference them as `${NAME}`.
3. Run `bb mcp-hub apply` and report which files changed.

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
- `"enabled": false` removes a server.
- Never edit a generated file by hand and expect it to persist: the next apply
  replaces it. Change the hub file instead.
- A file marked `foreign` belongs to the user. Do not pass `--force` without
  asking.
- `~/.bb/mcp/export/cursor-mcp.json` and `codex-config.toml` are for harnesses
  MCP Hub does not write to directly; hand them to the user when relevant.
