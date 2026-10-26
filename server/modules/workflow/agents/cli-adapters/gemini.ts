import type { CliAdapter, CliStreamEvent } from "./types.ts";

function planSubtaskTitles(content: string): string[] {
  const planMatch = content.match(/\{"subtasks"\s*:\s*\[.*?\]\}/s);
  if (!planMatch) return [];
  try {
    const plan = JSON.parse(planMatch[0]) as { subtasks?: Array<{ title?: unknown }> };
    return (plan.subtasks ?? []).map((st) => (typeof st?.title === "string" ? st.title.trim() : "")).filter(Boolean);
  } catch {
    return [];
  }
}

export const geminiAdapter: CliAdapter = {
  provider: "gemini",

  buildArgs({ model, noTools }) {
    const args = ["gemini"];
    if (model) args.push("-m", model);
    if (noTools) {
      args.push("--approval-mode", "plan", "--output-format=stream-json");
    } else {
      args.push("--yolo", "--output-format=stream-json");
    }
    return args;
  },

  parseEvent(j) {
    if (j.type === "message" && j.role === "assistant" && j.content) {
      const content = String(j.content);
      const events: CliStreamEvent[] = [{ kind: "text", text: content }];
      const titles = planSubtaskTitles(content);
      if (titles.length > 0) events.push({ kind: "plan_subtasks", titles });
      const doneMatch = content.match(/\{"subtask_done"\s*:\s*"(.+?)"\}/);
      if (doneMatch?.[1]) events.push({ kind: "plan_subtask_done", title: doneMatch[1] });
      return events;
    }
    if (j.type === "message" || j.type === "init") return [];
    if ((j.type === "tool_use" || j.type === "tool_result") && typeof j.tool_id === "string") return [];
    return null;
  },
};
