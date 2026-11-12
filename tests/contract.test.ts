import { describe, expect, it } from "vitest";
import {
  hubFileSchema,
  hubServerSchema,
  serverDefinitionSchema,
} from "../contract";

describe("hubServerSchema", () => {
  it("keeps harness keys MCP Hub does not model", () => {
    const parsed = hubServerSchema.parse({
      url: "https://x",
      timeout: 60000,
      oauth: false,
    });
    expect(parsed).toMatchObject({ url: "https://x", timeout: 60000, oauth: false });
  });
});

describe("serverDefinitionSchema", () => {
  it("accepts an Advanced-options passthrough key", () => {
    const parsed = serverDefinitionSchema.safeParse({
      url: "https://x",
      timeout: 60000,
    });
    expect(parsed.success).toBe(true);
  });

  it("requires exactly one transport", () => {
    expect(serverDefinitionSchema.safeParse({ url: "https://x" }).success).toBe(true);
    expect(
      serverDefinitionSchema.safeParse({ command: "npx", args: ["-y"] }).success,
    ).toBe(true);
    expect(
      serverDefinitionSchema.safeParse({ url: "https://x", command: "npx" }).success,
    ).toBe(false);
    expect(serverDefinitionSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty url or command", () => {
    expect(serverDefinitionSchema.safeParse({ url: "" }).success).toBe(false);
    expect(serverDefinitionSchema.safeParse({ command: "" }).success).toBe(false);
  });

  it("lets a remote server keep its SSE type", () => {
    const parsed = serverDefinitionSchema.safeParse({
      url: "https://x",
      type: "sse",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("hubFileSchema", () => {
  it("defaults missing servers to an empty map", () => {
    expect(hubFileSchema.parse({})).toEqual({ servers: {} });
  });

  it("keeps unknown top-level keys", () => {
    const parsed = hubFileSchema.parse({
      servers: { a: { url: "https://x" } },
      $schema: "x",
    });
    expect(parsed).toMatchObject({ $schema: "x" });
  });
});
