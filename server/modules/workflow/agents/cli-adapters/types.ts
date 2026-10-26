/**
 * One adapter per agent CLI. An adapter owns everything that depends on that CLI's version:
 * the argv used to launch it and how its stream-json output is read. Callers only see the
 * normalized events below, so a CLI format change is fixed (and fixture-tested) in one file.
 */

export type CliStreamEvent =
  /** Assistant text. `inline` text is appended as-is (streamed deltas); otherwise it is its own block. */
  | { kind: "text"; text: string; inline?: boolean }
  | { kind: "reasoning"; text: string }
  /** The run's final answer, which usually repeats the last assistant message. */
  | { kind: "final_result"; text: string }
  | { kind: "subagent_started"; id: string; title: string }
  | { kind: "subagent_finished"; id: string }
  /** Codex reports the spawned agent's thread only when spawn_agent completes. */
  | { kind: "subagent_thread_linked"; id: string; threadId: string }
  | { kind: "subagent_threads_closed"; threadIds: string[] }
  /** A plan the model printed as {"subtasks":[{"title":...}]} (Gemini). */
  | { kind: "plan_subtasks"; titles: string[] }
  /** The model reported a planned subtask as finished with {"subtask_done":"<title>"} (Gemini). */
  | { kind: "plan_subtask_done"; title: string };

export type CliStreamState = {
  /** Claude streamed text deltas, so its full `assistant` message must not be printed again. */
  sawTextDelta: boolean;
};

export type CliArgsOptions = {
  model?: string;
  reasoningLevel?: string;
  /** Read-only / no-tool runs (meetings, chat replies). */
  noTools?: boolean;
};

export interface CliAdapter {
  provider: string;
  buildArgs(opts: CliArgsOptions): string[];
  /** Normalized events for one parsed JSON line, or null when the line is not in this CLI's format. */
  parseEvent(event: Record<string, any>, state: CliStreamState): CliStreamEvent[] | null;
}

export function createCliStreamState(): CliStreamState {
  return { sawTextDelta: false };
}
