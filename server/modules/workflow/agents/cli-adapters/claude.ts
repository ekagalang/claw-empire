import type { CliAdapter, CliStreamEvent } from "./types.ts";

// Claude Code names its sub-agent tool "Agent"; older versions called it "Task".
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

function subagentTitle(input: Record<string, any> | undefined): string {
  const description = typeof input?.description === "string" ? input.description.trim() : "";
  if (description) return description.slice(0, 100);
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  return prompt ? prompt.slice(0, 100) : "Sub-task";
}

export const claudeAdapter: CliAdapter = {
  provider: "claude",

  buildArgs({ model, noTools }) {
    const args = [
      "claude",
      "--dangerously-skip-permissions",
      "--print",
      "--verbose",
      "--output-format=stream-json",
      "--include-partial-messages",
      "--max-turns",
      "200",
    ];
    if (model) args.push("--model", model);
    // Keep no-tools as a single argv token so the empty value survives every shell.
    if (noTools) args.push("--tools=");
    return args;
  },

  parseEvent(j, state) {
    // Session metadata (init, status, rate-limit notices): nothing to show.
    if (j.type === "system") return [];

    if (j.type === "stream_event") {
      // Deltas of a sub-agent's own messages are not part of the main answer.
      if (j.parent_tool_use_id) return [];
      const ev = j.event;
      if (ev?.type === "content_block_delta" && ev?.delta?.type === "text_delta") {
        state.sawTextDelta = true;
        return [{ kind: "text", text: String(ev.delta.text ?? ""), inline: true }];
      }
      if (ev?.type === "content_block_start" && ev?.content_block?.type === "text" && ev?.content_block?.text) {
        return [{ kind: "text", text: String(ev.content_block.text), inline: true }];
      }
      return [];
    }

    if (j.type === "assistant" && Array.isArray(j.message?.content)) {
      const events: CliStreamEvent[] = [];
      const isSubagentMessage = Boolean(j.parent_tool_use_id);
      let text = "";
      for (const block of j.message.content) {
        if (block?.type === "text" && block.text && !state.sawTextDelta && !isSubagentMessage) {
          text += String(block.text);
        }
        if (block?.type === "tool_use" && SUBAGENT_TOOL_NAMES.has(String(block.name))) {
          events.push({
            kind: "subagent_started",
            id: String(block.id || `sub-${Date.now()}`),
            title: subagentTitle(block.input),
          });
        }
      }
      if (text) events.unshift({ kind: "text", text });
      return events;
    }

    if (j.type === "user" && Array.isArray(j.message?.content)) {
      const events: CliStreamEvent[] = [];
      for (const block of j.message.content) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && block.tool_use_id) {
          // Finishing an unknown tool_use id is a no-op for the subtask tracker.
          events.push({ kind: "subagent_finished", id: block.tool_use_id });
        }
      }
      return events;
    }

    if (j.type === "result" && j.result) {
      return [{ kind: "final_result", text: String(j.result) }];
    }

    // Legacy top-level shape emitted by older Claude Code builds.
    if (j.type === "tool_use" && j.tool === "Task") {
      return [{ kind: "subagent_started", id: String(j.id || `sub-${Date.now()}`), title: subagentTitle(j.input) }];
    }
    if (j.type === "tool_result" && j.tool === "Task") {
      return j.id ? [{ kind: "subagent_finished", id: String(j.id) }] : [];
    }

    return null;
  },
};
