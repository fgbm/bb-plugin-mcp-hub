import { describe, expect, it } from "vitest";
import {
  MODELLED_KEYS,
  isRecord,
  readVars,
  referencedVars,
  serverEntries,
  serverFromEntry,
  splitCommand,
} from "../shared";

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("readVars", () => {
  it("keeps only string values", () => {
    expect(readVars({ vars: { A: "1", B: 2, C: null } })).toEqual({ A: "1" });
    expect(readVars({ vars: "no" })).toEqual({});
    expect(readVars(null)).toEqual({});
    expect(readVars("file")).toEqual({});
  });
});

describe("referencedVars", () => {
  it("finds names at any depth without duplicates", () => {
    expect(
      referencedVars({
        url: "https://x/${X}",
        headers: { A: "${Y}", B: ["${X}", { C: "${Z}" }] },
        n: 3,
      }),
    ).toEqual(["X", "Y", "Z"]);
  });

  it("ignores malformed references", () => {
    expect(referencedVars("${lower} ${} ${OK_1}")).toEqual(["OK_1"]);
  });
});

describe("splitCommand", () => {
  it("groups quoted words", () => {
    expect(splitCommand('npx "a b" \'c d\'')).toEqual(["npx", "a b", "c d"]);
  });

  it("keeps an unterminated quote together", () => {
    expect(splitCommand('run "a b')).toEqual(["run", "a b"]);
  });

  it("returns nothing for blank input", () => {
    expect(splitCommand("   ")).toEqual([]);
  });
});

describe("serverEntries", () => {
  const servers = { a: { url: "https://a" } };

  it("reads OpenCode v2", () => {
    expect(serverEntries("opencode", { mcp: { servers } })).toEqual(servers);
  });

  it("reads OpenCode v1 and skips timeout", () => {
    expect(
      serverEntries("opencode", {
        mcp: { a: { url: "https://a" }, timeout: { catalog: 1 } },
      }),
    ).toEqual(servers);
  });

  it("reads mcpServers and servers", () => {
    expect(serverEntries("claude", { mcpServers: servers })).toEqual(servers);
    expect(serverEntries("cursor", { mcpServers: servers })).toEqual(servers);
    expect(serverEntries("vscode", { servers })).toEqual(servers);
  });

  it("auto prefers mcpServers, then mcp, then servers", () => {
    expect(
      serverEntries("auto", {
        mcpServers: { shared: { url: "https://s" } },
        mcp: { servers: { nested: { url: "https://n" } } },
        servers: { vscode: { url: "https://v" } },
      }),
    ).toEqual({ shared: { url: "https://s" } });
    expect(
      serverEntries("auto", {
        mcp: { servers: { nested: { url: "https://n" } } },
        servers: { vscode: { url: "https://v" } },
      }),
    ).toEqual({ nested: { url: "https://n" } });
    expect(serverEntries("auto", { servers })).toEqual(servers);
  });

  it("returns null for the wrong shape", () => {
    expect(serverEntries("auto", null)).toBeNull();
    expect(serverEntries("claude", { servers })).toBeNull();
    expect(serverEntries("opencode", { mcp: { timeout: 1 } })).toBeNull();
  });
});

describe("serverFromEntry", () => {
  it("normalises a remote entry and keeps SSE", () => {
    expect(
      serverFromEntry({
        url: "https://x/mcp",
        type: "sse",
        headers: { A: "1", B: 2 },
        timeout: 5,
      }),
    ).toEqual({
      url: "https://x/mcp",
      type: "sse",
      headers: { A: "1" },
      timeout: 5,
    });
  });

  it("drops a plain http type and a modelled flag", () => {
    expect(serverFromEntry({ url: "https://x", type: "http", enabled: true })).toEqual({
      url: "https://x",
    });
  });

  it("combines array command, args and env", () => {
    expect(
      serverFromEntry({
        command: ["uv", "run"],
        args: ["script"],
        environment: { A: "1", B: 2 },
        env: { IGNORED: "1" },
        disabled: true,
      }),
    ).toEqual({
      command: "uv",
      args: ["run", "script"],
      env: { A: "1" },
      enabled: false,
    });
  });

  it("splits a command string only when asked", () => {
    expect(
      serverFromEntry({ command: "npx -y pkg" }, { splitCommand: true }),
    ).toEqual({ command: "npx", args: ["-y", "pkg"] });
    expect(serverFromEntry({ command: "npx -y pkg" })).toEqual({
      command: "npx -y pkg",
    });
  });

  it("rejects entries without a transport", () => {
    expect(serverFromEntry({})).toBeNull();
    expect(serverFromEntry({ command: "" })).toBeNull();
    expect(serverFromEntry({ url: 5 })).toBeNull();
    expect(serverFromEntry("entry")).toBeNull();
  });

  it("keeps unknown harness keys out of modelled fields", () => {
    expect(MODELLED_KEYS.has("type")).toBe(true);
    expect(MODELLED_KEYS.has("timeout")).toBe(false);
    expect(serverFromEntry({ command: "npx", oauth: false })).toEqual({
      command: "npx",
      oauth: false,
    });
  });
});
