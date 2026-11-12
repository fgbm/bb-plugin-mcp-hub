import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => state.home };
});

import hostEntry from "../host";

type Handler = (input: unknown, context: unknown) => unknown;

const handler = hostEntry.handlers as unknown as Record<string, Handler>;
const context = {
  signal: new AbortController().signal,
  lifecycle: { signal: new AbortController().signal },
};

const call = (name: string, input: unknown): any => handler[name](input, context);

const hub = () => join(state.home, ".bb");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

beforeAll(() => {
  state.home = mkdtempSync(join(tmpdir(), "bb-mcp-hub-test-"));
});

afterAll(() => {
  rmSync(state.home, { recursive: true, force: true });
});

describe("apply", () => {
  it("writes an owned file and records it in state", () => {
    const path = join(hub(), "mcp", "opencode.json");
    const result = call("apply", {
      files: [{ path, content: "one\n", mode: 0o600 }],
      remove: [],
      force: false,
    });
    expect(result.results[0]).toEqual({ path, status: "written", message: null });
    expect(readFileSync(path, "utf8")).toBe("one\n");
    expect(existsSync(join(hub(), "mcp", "state.json"))).toBe(true);
  });

  it("reports identical content as unchanged", () => {
    const path = join(hub(), "mcp", "opencode.json");
    const result = call("apply", {
      files: [{ path, content: "one\n", mode: 0o600 }],
      remove: [],
      force: false,
    });
    expect(result.results[0]?.status).toBe("unchanged");
  });

  it("leaves a hand-edited file alone unless forced, then backs it up", () => {
    const path = join(hub(), "mcp", "opencode.json");
    writeFileSync(path, "user\n");

    const foreign = call("apply", {
      files: [{ path, content: "two\n", mode: 0o600 }],
      remove: [],
      force: false,
    });
    expect(foreign.results[0]?.status).toBe("foreign");
    expect(readFileSync(path, "utf8")).toBe("user\n");

    const forced = call("apply", {
      files: [{ path, content: "two\n", mode: 0o600 }],
      remove: [],
      force: true,
    });
    expect(forced.results[0]?.status).toBe("written");
    expect(readFileSync(path, "utf8")).toBe("two\n");
    expect(existsSync(join(hub(), "mcp", "backups"))).toBe(true);
  });

  it("removes an owned target and keeps a foreign one", () => {
    const owned = join(hub(), "mcp", "export", "cursor-mcp.json");
    call("apply", {
      files: [{ path: owned, content: "owned\n", mode: 0o600 }],
      remove: [],
      force: false,
    });
    const removed = call("apply", { files: [], remove: [owned], force: false });
    expect(removed.results[0]?.status).toBe("removed");
    expect(existsSync(owned)).toBe(false);

    const foreign = join(hub(), "mcp", "export", "foreign.json");
    writeFileSync(foreign, "user\n");
    const kept = call("apply", { files: [], remove: [foreign], force: false });
    expect(kept.results[0]?.status).toBe("foreign");
    expect(existsSync(foreign)).toBe(true);

    const forced = call("apply", { files: [], remove: [foreign], force: true });
    expect(forced.results[0]?.status).toBe("removed");
    expect(existsSync(foreign)).toBe(false);
  });
});

describe("hub files", () => {
  it("saves a server and its values, then reveals and clears them", () => {
    call("saveServer", {
      scope: "host",
      projectPath: null,
      name: "probe",
      previousName: null,
      server: { url: "https://x", timeout: 5 },
      vars: { TOKEN: "secret" },
    });

    const file = readJson(join(hub(), "mcp.json")) as {
      servers: Record<string, unknown>;
    };
    expect(file.servers["probe"]).toEqual({ url: "https://x", timeout: 5 });

    const local = readJson(join(hub(), "mcp.local.json")) as {
      vars: Record<string, string>;
    };
    expect(local.vars["TOKEN"]).toBe("secret");
    expect(
      call("revealVar", { scope: "host", projectPath: null, name: "TOKEN" }),
    ).toEqual({ value: "secret" });

    call("setVar", {
      scope: "host",
      projectPath: null,
      name: "TOKEN",
      value: null,
    });
    expect(
      call("revealVar", { scope: "host", projectPath: null, name: "TOKEN" }),
    ).toEqual({ value: null });
  });

  it("imports, renames and deletes servers", () => {
    call("importServers", {
      scope: "host",
      projectPath: null,
      entries: [
        { name: "a", server: { url: "https://a" } },
        { name: "b", server: { command: "uv" } },
      ],
    });
    const file = readJson(join(hub(), "mcp.json")) as {
      servers: Record<string, unknown>;
    };
    expect(Object.keys(file.servers)).toEqual(expect.arrayContaining(["a", "b"]));

    call("saveServer", {
      scope: "host",
      projectPath: null,
      name: "c",
      previousName: "a",
      server: { url: "https://c" },
      vars: null,
    });
    const renamed = readJson(join(hub(), "mcp.json")) as {
      servers: Record<string, unknown>;
    };
    expect(renamed.servers["a"]).toBeUndefined();
    expect(renamed.servers["c"]).toEqual({ url: "https://c" });

    call("deleteServer", { scope: "host", projectPath: null, name: "b" });
    const deleted = readJson(join(hub(), "mcp.json")) as {
      servers: Record<string, unknown>;
    };
    expect(deleted.servers["b"]).toBeUndefined();
  });

  it("refuses to overwrite invalid JSON", () => {
    const path = join(hub(), "mcp.json");
    writeFileSync(path, "{ broken");
    expect(() =>
      call("saveServer", {
        scope: "host",
        projectPath: null,
        name: "x",
        previousName: null,
        server: { url: "https://x" },
        vars: null,
      }),
    ).toThrow(/refuse to overwrite/);
    expect(readFileSync(path, "utf8")).toBe("{ broken");
  });

  it("reads environment values from this host", () => {
    const result = call("envVars", { names: ["PATH", "BB_TEST_MISSING"] });
    expect(typeof result.values["PATH"]).toBe("string");
    expect(result.values["BB_TEST_MISSING"]).toBeNull();
  });
});

describe("snapshot", () => {
  it("returns parsed foreign files and skips missing ones", () => {
    const good = join(state.home, "foreign.json");
    writeFileSync(good, JSON.stringify({ mcpServers: {} }));
    const result = call("snapshot", {
      projectPath: null,
      paths: [join(state.home, "missing.json")],
      foreignPaths: [good, join(state.home, "none.json")],
    });
    expect(result.files[0]?.exists).toBe(false);
    expect(result.foreign[0]).toMatchObject({ path: good, exists: true, error: null });
    expect(result.foreign[1]?.exists).toBe(false);
  });

  it("reports unreadable foreign files with an error", () => {
    const bad = join(state.home, "bad.json");
    writeFileSync(bad, "{ broken");
    const result = call("snapshot", {
      projectPath: null,
      paths: [],
      foreignPaths: [bad],
    });
    expect(result.foreign[0]?.error).toBeTruthy();
  });
});
