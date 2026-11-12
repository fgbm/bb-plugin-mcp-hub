import { describe, expect, it } from "vitest";
import type { HubServer } from "../contract";
import {
  findCollisions,
  joinHost,
  renderCodex,
  renderOpencode,
  renderShared,
  renderTargets,
} from "../server";

function entry(name: string, server: HubServer) {
  return { name, server };
}

const hostServers = [entry("host", { url: "https://host/mcp" })];
const projectServers = [entry("proj", { command: "uv", args: ["run", "x"] })];
const mergedServers = [...hostServers, ...projectServers];

describe("joinHost", () => {
  it("uses the separator of the target host", () => {
    expect(joinHost("C:\\Users\\me", ".bb", "mcp.json")).toBe(
      "C:\\Users\\me\\.bb\\mcp.json",
    );
    expect(joinHost("/home/me/", ".bb", "/mcp.json")).toBe("/home/me/.bb/mcp.json");
  });
});

describe("renderShared", () => {
  it("writes HTTP as the default remote type", () => {
    const json = JSON.parse(
      renderShared([
        entry("x", { url: "https://x", headers: { A: "1" }, timeout: 5 }),
      ]),
    ) as { mcpServers: Record<string, unknown> };
    expect(json.mcpServers["x"]).toMatchObject({
      type: "http",
      url: "https://x",
      headers: { A: "1" },
      timeout: 5,
    });
  });

  it("keeps SSE", () => {
    const json = JSON.parse(
      renderShared([entry("x", { url: "https://x", type: "sse" })]),
    ) as { mcpServers: Record<string, unknown> };
    expect(json.mcpServers["x"]).toMatchObject({ type: "sse", url: "https://x" });
  });

  it("writes command, args and env without a type", () => {
    const json = JSON.parse(
      renderShared([entry("x", { command: "uv", args: ["run"], env: { A: "1" } })]),
    ) as { mcpServers: Record<string, unknown> };
    expect(json.mcpServers["x"]).toEqual({
      command: "uv",
      args: ["run"],
      env: { A: "1" },
    });
  });
});

describe("renderOpencode", () => {
  it("writes the v2 shape and converts a numeric timeout", () => {
    const json = JSON.parse(
      renderOpencode([
        entry("r", { url: "https://x", headers: { A: "1" }, timeout: 60000 }),
      ]),
    ) as {
      $schema: string;
      mcp: { servers: Record<string, unknown> };
    };
    expect(json.$schema).toBe("https://opencode.ai/config.json");
    expect(json.mcp.servers["r"]).toMatchObject({
      type: "remote",
      url: "https://x",
      headers: { A: "1" },
      timeout: { catalog: 60000, execution: 60000 },
    });
  });

  it("writes a local command array and environment", () => {
    const json = JSON.parse(
      renderOpencode([
        entry("l", { command: "uv", args: ["run"], env: { A: "1" }, codemode: false }),
      ]),
    ) as { mcp: { servers: Record<string, unknown> } };
    expect(json.mcp.servers["l"]).toEqual({
      type: "local",
      command: ["uv", "run"],
      environment: { A: "1" },
      codemode: false,
    });
  });
});

describe("renderCodex", () => {
  it("writes remote and local tables and escapes values", () => {
    const text = renderCodex([
      entry("r", { url: "https://x", headers: { A: "1" } }),
      entry("l", { command: "uv", args: ["run"], env: { Q: 'a"b\\c' } }),
    ]);
    expect(text).toContain('[mcp_servers."r"]');
    expect(text).toContain('url = "https://x"');
    expect(text).toContain('http_headers = { "A" = "1" }');
    expect(text).toContain('command = "uv"');
    expect(text).toContain('args = ["run"]');
    expect(text).toContain('"Q" = "a\\"b\\\\c"');
  });
});

describe("findCollisions", () => {
  const sources = [{ path: "/c", kind: "claude" as const }];

  it("ignores a file with the same connection", () => {
    const files = [
      {
        path: "/c",
        exists: true,
        json: { mcpServers: { x: { url: "https://x" } } },
        error: null,
      },
    ];
    expect(findCollisions(sources, files, [entry("x", { url: "https://x" })])).toEqual(
      [],
    );
  });

  it("reports a different definition", () => {
    const files = [
      {
        path: "/c",
        exists: true,
        json: { mcpServers: { x: { url: "https://other" } } },
        error: null,
      },
    ];
    expect(findCollisions(sources, files, [entry("x", { url: "https://x" })])).toEqual([
      { server: "x", path: "/c" },
    ]);
  });

  it("skips missing and unreadable files", () => {
    expect(
      findCollisions(
        sources,
        [
          { path: "/c", exists: false, json: null, error: null },
          { path: "/d", exists: true, json: null, error: "bad" },
        ],
        [entry("x", { url: "https://x" })],
      ),
    ).toEqual([]);
  });

  it("reads the OpenCode shape", () => {
    const opencode = [{ path: "/o", kind: "opencode" as const }];
    const files = [
      {
        path: "/o",
        exists: true,
        json: { mcp: { servers: { x: { url: "https://other" } } } },
        error: null,
      },
    ];
    expect(
      findCollisions(opencode, files, [entry("x", { url: "https://x" })]),
    ).toHaveLength(1);
  });
});

describe("renderTargets", () => {
  const targets = {
    kimiCode: false,
    claudeCode: false,
    opencode: false,
    cursor: false,
    codex: false,
  };

  it("writes only the ignore file when no harness is enabled", () => {
    const result = renderTargets({
      home: "C:\\home",
      projectPath: "C:\\repo",
      projectAuthored: true,
      projectLocal: false,
      targets,
      hostServers,
      servers: mergedServers,
      projectServers,
    });
    expect(result.files.map((file) => file.path)).toEqual([
      "C:\\repo\\.bb\\.gitignore",
    ]);
    expect(result.reaches).toEqual({});
  });

  it("marks host files for Kimi and Claude", () => {
    const result = renderTargets({
      home: "C:\\home",
      projectPath: null,
      projectAuthored: null,
      projectLocal: false,
      targets: { ...targets, kimiCode: true, claudeCode: true },
      hostServers,
      servers: hostServers,
      projectServers: [],
    });
    expect(result.files.map((file) => file.path)).toEqual([
      "C:\\home\\.kimi-code\\mcp.json",
      "C:\\home\\.bb\\mcp\\export\\claude-user-mcp.json",
    ]);
    expect(result.reaches["host"]).toEqual(["kimi", "claude"]);
  });

  it("writes the project manifest, ignore file and project OpenCode", () => {
    const projectPath = "C:\\repo";
    const result = renderTargets({
      home: "C:\\home",
      projectPath,
      projectAuthored: true,
      projectLocal: false,
      targets: { ...targets, claudeCode: true, opencode: true },
      hostServers,
      servers: mergedServers,
      projectServers,
    });
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain("C:\\repo\\.mcp.json");
    expect(paths).toContain("C:\\repo\\.bb\\.gitignore");
    expect(paths).toContain("C:\\repo\\.bb\\mcp\\opencode.json");
    expect(result.reaches["proj"]).toEqual(["opencode", "claude"]);
    const ignore = result.files.find((file) => file.path.endsWith(".gitignore"));
    expect(ignore?.content).toBe("mcp.local.json\nmcp/\n");
  });

  it("keeps the ignore file when only local values exist", () => {
    const result = renderTargets({
      home: "/home/me",
      projectPath: "/repo",
      projectAuthored: false,
      projectLocal: true,
      targets,
      hostServers,
      servers: hostServers,
      projectServers: [],
    });
    expect(result.files.map((file) => file.path)).toEqual(["/repo/.bb/.gitignore"]);
  });

  it("marks Cursor and Codex for merged project servers", () => {
    const result = renderTargets({
      home: "/home/me",
      projectPath: null,
      projectAuthored: null,
      projectLocal: false,
      targets: { ...targets, cursor: true, codex: true },
      hostServers,
      servers: mergedServers,
      projectServers: [],
    });
    expect(result.reaches["proj"]).toEqual(["cursor", "codex"]);
  });
});
