import type { CliAdapter } from "./types.ts";

/**
 * Kimi (`kimi --print --output-format=stream-json`) prints chat-style messages
 * ({"role":"assistant","content":...}). The same reader is the last-resort fallback for any
 * other CLI that emits role-based messages or plain {type:"assistant_message"|"output_text"} lines.
 */
export const kimiAdapter: CliAdapter = {
  provider: "kimi",

  buildArgs({ model }) {
    const args = ["kimi", "--print", "--output-format=stream-json"];
    if (model) args.push("-m", model);
    return args;
  },

  parseEvent(j) {
    if (j.role === "assistant") {
      if (typeof j.content === "string") return j.content ? [{ kind: "text", text: j.content }] : [];
      if (Array.isArray(j.content)) {
        const parts: string[] = [];
        for (const part of j.content) {
          if (typeof part === "string") parts.push(part);
          else if (part && typeof part.text === "string") parts.push(part.text);
        }
        const text = parts.join("\n");
        return text ? [{ kind: "text", text }] : [];
      }
      return [];
    }
    if (typeof j.text === "string" && (j.type === "assistant_message" || j.type === "output_text")) {
      return j.text ? [{ kind: "text", text: j.text }] : [];
    }
    return null;
  },
};
