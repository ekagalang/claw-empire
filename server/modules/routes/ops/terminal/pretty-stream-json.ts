import { createCliStreamState, parseCliStreamLine } from "../../../workflow/agents/cli-adapters/index.ts";

/**
 * Turn raw CLI stream-json output (any supported CLI) into readable assistant text.
 * Line formats are interpreted by the per-CLI adapters in workflow/agents/cli-adapters.
 */
export function prettyStreamJson(raw: string, opts: { includeReasoning?: boolean } = {}): string {
  const chunks: string[] = [];
  const state = createCliStreamState();
  let sawJson = false;
  const includeReasoning = opts.includeReasoning === true;
  const pushMessageChunk = (text: string): void => {
    if (!text) return;
    if (chunks.length > 0 && !chunks[chunks.length - 1].endsWith("\n")) {
      chunks.push("\n");
    }
    chunks.push(text);
    if (!text.endsWith("\n")) {
      chunks.push("\n");
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    const events = parseCliStreamLine(line, state);
    if (events === null) continue;
    sawJson = true;

    for (const event of events) {
      switch (event.kind) {
        case "text":
          if (event.inline) chunks.push(event.text);
          else pushMessageChunk(event.text);
          break;
        case "reasoning":
          if (includeReasoning) pushMessageChunk(`[reasoning] ${event.text}`);
          break;
        case "final_result": {
          // Claude's closing `result` repeats the last assistant message; print it only when
          // the answer was not already streamed (e.g. a run that produced no assistant text).
          const finalText = event.text.trim();
          if (finalText && !chunks.join("").trimEnd().endsWith(finalText)) pushMessageChunk(event.text);
          break;
        }
        default:
          break;
      }
    }
  }

  if (!sawJson) {
    return raw.trim();
  }

  const stitched = chunks.join("");
  const normalized = stitched
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return normalized;
}
