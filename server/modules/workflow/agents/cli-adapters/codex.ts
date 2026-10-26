import type { CliAdapter } from "./types.ts";

function codexSpawnTitle(prompt: unknown): string {
  const first = (typeof prompt === "string" && prompt ? prompt : "Sub-agent").split("\n")[0] ?? "";
  return first.replace(/^Task:\s*/, "").slice(0, 100) || "Sub-agent";
}

function threadIds(item: Record<string, any>): string[] {
  return Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.map(String).filter(Boolean) : [];
}

export const codexAdapter: CliAdapter = {
  provider: "codex",

  buildArgs({ model, reasoningLevel, noTools }) {
    const args = ["codex"];
    if (!noTools) args.push("--enable", "multi_agent");
    if (model) args.push("-m", model);
    if (reasoningLevel) args.push("-c", `model_reasoning_effort="${reasoningLevel}"`);
    if (!noTools) args.push("--yolo");
    args.push("exec", "--json");
    if (noTools) args.push("--sandbox", "read-only");
    return args;
  },

  parseEvent(j) {
    if (j.type === "item.started" && j.item && typeof j.item === "object") {
      const item = j.item;
      if (item.type === "collab_tool_call" && item.tool === "spawn_agent") {
        return [
          {
            kind: "subagent_started",
            id: String(item.id || `codex-spawn-${Date.now()}`),
            title: codexSpawnTitle(item.prompt),
          },
        ];
      }
      return [];
    }

    if (j.type === "item.completed" && j.item && typeof j.item === "object") {
      const item = j.item;
      if (item.type === "agent_message" && item.text) return [{ kind: "text", text: String(item.text) }];
      if (item.type === "reasoning" && item.text) return [{ kind: "reasoning", text: String(item.text) }];
      if (item.type === "collab_tool_call") {
        const ids = threadIds(item);
        if (item.tool === "spawn_agent" && item.id && ids[0]) {
          return [{ kind: "subagent_thread_linked", id: String(item.id), threadId: ids[0] }];
        }
        if (item.tool === "close_agent" && ids.length > 0) {
          return [{ kind: "subagent_threads_closed", threadIds: ids }];
        }
      }
      return [];
    }

    if (typeof j.type === "string" && /^(thread|turn)\./.test(j.type)) return [];
    return null;
  },
};
