import { describe, expect, it } from "vitest";
import { createCliTools, createStreamLineBuffer, isSafeCliArgValue } from "./cli-tools.ts";

function createTools() {
  return createCliTools({
    nowMs: () => 0,
    cliOutputDedupWindowMs: 1000,
  });
}

describe("buildAgentArgs", () => {
  it("claude noTools mode uses --tools= without empty argv", () => {
    const tools = createTools();
    const args = tools.buildAgentArgs("claude", "claude-opus-4-6", undefined, { noTools: true });

    expect(args).toContain("--tools=");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("");
  });

  it("rejects model and reasoning values that a shell could interpret", () => {
    const tools = createTools();
    for (const model of ["sonnet & calc", "x|y", "a;b", "%PATH%", "--yolo", "a b", 'a"b', "a^b", "$(id)"]) {
      expect(() => tools.buildAgentArgs("claude", model)).toThrow(/invalid model/);
    }
    expect(() => tools.buildAgentArgs("codex", "gpt-5", "high&calc")).toThrow(/invalid reasoning level/);
  });

  it("accepts real-world model ids", () => {
    const tools = createTools();
    for (const model of ["claude-opus-4-6", "sonnet[1m]", "openrouter/anthropic/claude-sonnet-4.5", "gpt-5.3-codex"]) {
      expect(() => tools.buildAgentArgs("claude", model)).not.toThrow();
    }
    expect(isSafeCliArgValue("high")).toBe(true);
  });
});

describe("createStreamLineBuffer", () => {
  it("does not corrupt multibyte characters split across chunks", () => {
    const buffer = createStreamLineBuffer();
    const bytes = Buffer.from('{"text":"halo 👋 안녕"}\n', "utf8");
    const splitAt = bytes.indexOf(0xf0) + 2; // inside the 4-byte emoji
    const out = buffer.push(bytes.subarray(0, splitAt)) + buffer.push(bytes.subarray(splitAt)) + buffer.flush();
    expect(out).toBe('{"text":"halo 👋 안녕"}\n');
  });

  it("only releases complete lines and flushes the remainder", () => {
    const buffer = createStreamLineBuffer();
    expect(buffer.push('{"type":"assi')).toBe("");
    expect(buffer.push('stant"}\n{"type":')).toBe('{"type":"assistant"}\n');
    expect(buffer.flush()).toBe('{"type":');
    expect(buffer.flush()).toBe("");
  });
});
