import type { CliAdapter } from "./types.ts";

function partText(j: Record<string, any>): string {
  if (typeof j.part?.text === "string") return j.part.text;
  if (typeof j.text === "string") return j.text;
  return "";
}

export const opencodeAdapter: CliAdapter = {
  provider: "opencode",

  buildArgs({ model }) {
    const args = ["opencode", "run"];
    if (model) args.push("-m", model);
    args.push("--format", "json");
    return args;
  },

  parseEvent(j) {
    if (j.type === "text") {
      const text = partText(j);
      if (j.part?.type === "reasoning" || j.part?.type === "thinking") {
        return text ? [{ kind: "reasoning", text }] : [];
      }
      return text ? [{ kind: "text", text, inline: true }] : [];
    }
    if (j.type === "thinking" || j.type === "reasoning") {
      const text = partText(j) || (typeof j.content === "string" ? j.content : "");
      return text ? [{ kind: "reasoning", text }] : [];
    }
    if (j.type === "content" && (j.content || j.text)) {
      return [{ kind: "text", text: String(j.content ?? j.text), inline: true }];
    }
    if (j.type === "step_finish" || j.type === "step-finish" || j.type === "step_start" || j.type === "step-start") {
      return [];
    }
    if ((j.type === "tool_use" || j.type === "tool_result") && j.part) return [];
    return null;
  },
};
