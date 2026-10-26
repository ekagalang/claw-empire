import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prettyStreamJson } from "../../../routes/ops/terminal/pretty-stream-json.ts";
import {
  createCliStreamState,
  getCliAdapter,
  listCliAdapterProviders,
  parseCliStreamLine,
  type CliStreamEvent,
} from "./index.ts";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

function events(name: string): CliStreamEvent[] {
  const state = createCliStreamState();
  return fixture(name)
    .split(/\r?\n/)
    .flatMap((line) => parseCliStreamLine(line, state) ?? []);
}

function subagentEvents(name: string): CliStreamEvent[] {
  return events(name).filter((e) => e.kind !== "text" && e.kind !== "reasoning" && e.kind !== "final_result");
}

describe("recorded CLI output stays understood", () => {
  // Real recordings: every JSON line must be claimed by an adapter. A new event type in a CLI
  // update shows up here instead of being silently ignored.
  for (const name of [
    "claude-2.1.285-auth-error.jsonl",
    "codex-0.154.0-text.jsonl",
    "codex-0.154.0-collab-wait.jsonl",
  ]) {
    it(`claims every line of ${name}`, () => {
      const state = createCliStreamState();
      const unclaimed = fixture(name)
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith("{"))
        .filter((line) => {
          const event = JSON.parse(line);
          return listCliAdapterProviders().every(
            (provider) => getCliAdapter(provider)?.parseEvent(event, state) === null,
          );
        });
      expect(unclaimed).toEqual([]);
    });
  }
});

describe("prettyStreamJson", () => {
  const cases: Array<[string, string, string?]> = [
    // [fixture, plain output, output with reasoning (defaults to plain)]
    ["claude-2.1.285-auth-error.jsonl", "Failed to authenticate: OAuth session expired and could not be refreshed"],
    ["claude-stream-text.jsonl", "Halo, tugas selesai 👋"],
    ["claude-subagent.jsonl", "Delegating the audit.\nBoth sub-agents finished."],
    ["claude-legacy-task.jsonl", ""],
    ["codex-0.154.0-text.jsonl", "OK"],
    ["codex-0.154.0-collab-wait.jsonl", "DONE"],
    ["codex-subagent.jsonl", "DONE", "[reasoning] Sub-agent replied pong.\nDONE"],
    [
      "gemini-stream.jsonl",
      'Here is the plan: {"subtasks": [{"title": "Design schema"}, {"title": "Write API"}]}\nPlan ready.',
    ],
    [
      "opencode-run.jsonl",
      "Updated README with setup notes.",
      "[reasoning] Thinking about the change.\nUpdated README with setup notes.",
    ],
    ["kimi-print.jsonl", "Kimi analysed the repo.\nNo issues found.\nFinal answer from Kimi."],
  ];

  for (const [name, plain, withReasoning] of cases) {
    it(`renders ${name}`, () => {
      const raw = fixture(name);
      expect(prettyStreamJson(raw)).toBe(plain);
      expect(prettyStreamJson(raw, { includeReasoning: true })).toBe(withReasoning ?? plain);
    });
  }

  it("does not print Claude's final result twice", () => {
    // The `result` line repeats the streamed answer; it used to be appended a second time.
    expect(prettyStreamJson(fixture("claude-stream-text.jsonl")).match(/tugas selesai/g)).toHaveLength(1);
  });

  it("still prints a final result that was never streamed", () => {
    expect(prettyStreamJson('{"type":"result","subtype":"success","result":"Only in result"}')).toBe("Only in result");
  });

  it("returns plain text output unchanged", () => {
    expect(prettyStreamJson("  plain CLI output\n")).toBe("plain CLI output");
  });
});

describe("sub-agent tracking", () => {
  it("detects Claude Agent/Task tool calls nested in assistant messages", () => {
    expect(subagentEvents("claude-subagent.jsonl")).toEqual([
      { kind: "subagent_started", id: "toolu_01AAA", title: "Audit login form" },
      { kind: "subagent_finished", id: "toolu_01AAA" },
      { kind: "subagent_started", id: "toolu_01BBB", title: "Write regression test" },
      { kind: "subagent_finished", id: "toolu_01BBB" },
    ]);
  });

  it("keeps supporting the legacy top-level Task shape", () => {
    expect(subagentEvents("claude-legacy-task.jsonl")).toEqual([
      { kind: "subagent_started", id: "legacy-task-1", title: "Legacy sub-agent" },
      { kind: "subagent_finished", id: "legacy-task-1" },
    ]);
  });

  it("follows Codex spawn_agent → thread → close_agent", () => {
    expect(subagentEvents("codex-subagent.jsonl")).toEqual([
      { kind: "subagent_started", id: "item_0", title: "Reply with the single word pong." },
      { kind: "subagent_thread_linked", id: "item_0", threadId: "bbbbbbbb-0000-7000-8000-000000000002" },
      { kind: "subagent_threads_closed", threadIds: ["bbbbbbbb-0000-7000-8000-000000000002"] },
    ]);
  });

  it("ignores Codex wait calls without a spawn", () => {
    expect(subagentEvents("codex-0.154.0-collab-wait.jsonl")).toEqual([]);
  });

  it("reads Gemini plan subtasks", () => {
    expect(subagentEvents("gemini-stream.jsonl")).toEqual([
      { kind: "plan_subtasks", titles: ["Design schema", "Write API"] },
    ]);
  });
});

describe("CLI arguments", () => {
  it("builds the expected argv per CLI", () => {
    const build = (provider: string, opts: Parameters<NonNullable<ReturnType<typeof getCliAdapter>>["buildArgs"]>[0]) =>
      getCliAdapter(provider)?.buildArgs(opts);

    expect(build("claude", { model: "sonnet" })).toEqual([
      "claude",
      "--dangerously-skip-permissions",
      "--print",
      "--verbose",
      "--output-format=stream-json",
      "--include-partial-messages",
      "--max-turns",
      "200",
      "--model",
      "sonnet",
    ]);
    expect(build("claude", { noTools: true })).toContain("--tools=");
    expect(build("codex", { model: "gpt-5", reasoningLevel: "high" })).toEqual([
      "codex",
      "--enable",
      "multi_agent",
      "-m",
      "gpt-5",
      "-c",
      'model_reasoning_effort="high"',
      "--yolo",
      "exec",
      "--json",
    ]);
    expect(build("codex", { noTools: true })).toEqual(["codex", "exec", "--json", "--sandbox", "read-only"]);
    expect(build("gemini", { noTools: true })).toEqual([
      "gemini",
      "--approval-mode",
      "plan",
      "--output-format=stream-json",
    ]);
    expect(build("opencode", { model: "x/y" })).toEqual(["opencode", "run", "-m", "x/y", "--format", "json"]);
    expect(build("kimi", {})).toEqual(["kimi", "--print", "--output-format=stream-json"]);
  });

  it("has no adapter for HTTP-based providers", () => {
    expect(getCliAdapter("copilot")).toBeNull();
    expect(getCliAdapter("antigravity")).toBeNull();
  });
});
