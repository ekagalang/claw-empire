import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { geminiAdapter } from "./gemini.ts";
import { kimiAdapter } from "./kimi.ts";
import { opencodeAdapter } from "./opencode.ts";
import type { CliAdapter, CliStreamEvent, CliStreamState } from "./types.ts";

export type { CliAdapter, CliArgsOptions, CliStreamEvent, CliStreamState } from "./types.ts";
export { createCliStreamState } from "./types.ts";

const ADAPTERS: Record<string, CliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
  kimi: kimiAdapter,
};

/**
 * Order used to recognise a line when the provider is unknown (logs and replies are parsed
 * without it). Kimi's role-based reader goes last because it doubles as the generic fallback.
 */
const DETECTION_ORDER: CliAdapter[] = [claudeAdapter, codexAdapter, geminiAdapter, opencodeAdapter, kimiAdapter];

export function getCliAdapter(provider: string): CliAdapter | null {
  return ADAPTERS[provider] ?? null;
}

export function listCliAdapterProviders(): string[] {
  return Object.keys(ADAPTERS);
}

/**
 * Parse one output line of any supported CLI. Returns null for lines that are not JSON objects
 * (plain-text output), and an empty list for JSON lines that carry nothing to show.
 */
export function parseCliStreamLine(line: string, state: CliStreamState): CliStreamEvent[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  for (const adapter of DETECTION_ORDER) {
    const events = adapter.parseEvent(event as Record<string, any>, state);
    if (events) return events;
  }
  return [];
}
