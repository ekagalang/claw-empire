import fs from "node:fs";
import path from "node:path";

import { DEFAULT_PROVIDER_MODEL_CONFIG } from "../../src/model-defaults.ts";
import { DEFAULT_DATA_ROOT, normalizePathEnv } from "./runtime.ts";

/**
 * Model lists and default model choices.
 *
 * Live discovery comes first (Codex's models cache, the installed Gemini CLI, `opencode models`,
 * the Copilot API). This catalog is only the fallback when discovery finds nothing, plus the
 * defaults seeded into new installs. It lives in one place instead of being spread across route
 * handlers, seeds and the frontend, and it can be overridden without code changes through a JSON
 * file (MODEL_CATALOG_PATH, default <data root>/model-catalog.json). In that file a provider's list
 * replaces the built-in list, and `defaults` entries are merged per provider.
 */

export type CatalogModel = { slug: string; displayName?: string };

export type ProviderModelDefaults = {
  model?: string;
  subModel?: string;
  reasoningLevel?: string;
  subModelReasoningLevel?: string;
};

export type ModelCatalog = {
  /** Fallback model lists for CLI providers. */
  cli: Record<string, CatalogModel[]>;
  /** Fallback model lists for OAuth/HTTP providers. */
  oauth: Record<string, string[]>;
  /** Model choices seeded into providerModelConfig on first run. */
  defaults: Record<string, ProviderModelDefaults>;
};

export const BUILTIN_MODEL_CATALOG: ModelCatalog = {
  cli: {
    // Claude Code has no model-list command. Its aliases always resolve to the newest model of
    // each tier, so they never go stale; pinned ids follow for users who want a fixed version.
    claude: [
      { slug: "opus", displayName: "Opus (latest)" },
      { slug: "sonnet", displayName: "Sonnet (latest)" },
      { slug: "haiku", displayName: "Haiku (latest)" },
      { slug: "claude-opus-4-6" },
      { slug: "claude-sonnet-4-6" },
      { slug: "claude-sonnet-4-5" },
      { slug: "claude-haiku-4-5" },
    ],
    codex: [
      { slug: "gpt-5.3-codex" },
      { slug: "gpt-5.2-codex" },
      { slug: "gpt-5.1-codex-max" },
      { slug: "gpt-5.2" },
      { slug: "gpt-5.1-codex-mini" },
    ],
    gemini: [
      { slug: "gemini-3-pro-preview", displayName: "Gemini 3 Pro Preview" },
      { slug: "gemini-3-flash-preview", displayName: "Gemini 3 Flash Preview" },
      { slug: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { slug: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
      { slug: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite" },
    ],
  },
  oauth: {
    copilot: [
      "github-copilot/claude-sonnet-4.6",
      "github-copilot/claude-sonnet-4.5",
      "github-copilot/claude-3.7-sonnet",
      "github-copilot/claude-3.5-sonnet",
      "github-copilot/gpt-4o",
      "github-copilot/gpt-4.1",
      "github-copilot/o4-mini",
      "github-copilot/gemini-2.5-pro",
    ],
    antigravity: [
      "google/antigravity-gemini-3-pro",
      "google/antigravity-gemini-3-flash",
      "google/antigravity-claude-sonnet-4-5",
      "google/antigravity-claude-sonnet-4-5-thinking",
      "google/antigravity-claude-opus-4-5-thinking",
      "google/antigravity-claude-opus-4-6-thinking",
    ],
  },
  defaults: DEFAULT_PROVIDER_MODEL_CONFIG,
};

const DEFAULT_MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** How long discovered model lists are reused before being fetched again (MODEL_CACHE_TTL_MS). */
export function getModelCacheTtlMs(): number {
  const raw = Number(process.env.MODEL_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MODEL_CACHE_TTL_MS;
}

export function getModelCatalogPath(): string {
  return normalizePathEnv(process.env.MODEL_CATALOG_PATH) || path.join(DEFAULT_DATA_ROOT, "model-catalog.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readCatalogModels(value: unknown): CatalogModel[] | null {
  if (!Array.isArray(value)) return null;
  const out: CatalogModel[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) out.push({ slug: entry.trim() });
    else if (isRecord(entry) && typeof entry.slug === "string" && entry.slug.trim()) {
      out.push({
        slug: entry.slug.trim(),
        ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}),
      });
    }
  }
  return out;
}

function readStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

/** Built-in catalog with the override file applied. Invalid or missing files are ignored. */
export function loadModelCatalog(catalogPath: string = getModelCatalogPath()): ModelCatalog {
  const catalog: ModelCatalog = {
    cli: { ...BUILTIN_MODEL_CATALOG.cli },
    oauth: { ...BUILTIN_MODEL_CATALOG.oauth },
    defaults: Object.fromEntries(
      Object.entries(BUILTIN_MODEL_CATALOG.defaults).map(([provider, value]) => [provider, { ...value }]),
    ),
  };

  let override: unknown;
  try {
    if (!fs.existsSync(catalogPath)) return catalog;
    override = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch (err) {
    console.warn(`[Claw-Empire] Ignoring invalid model catalog ${catalogPath}: ${String(err)}`);
    return catalog;
  }
  if (!isRecord(override)) return catalog;

  if (isRecord(override.cli)) {
    for (const [provider, list] of Object.entries(override.cli)) {
      const models = readCatalogModels(list);
      if (models) catalog.cli[provider] = models;
    }
  }
  if (isRecord(override.oauth)) {
    for (const [provider, list] of Object.entries(override.oauth)) {
      const models = readStringList(list);
      if (models) catalog.oauth[provider] = models;
    }
  }
  if (isRecord(override.defaults)) {
    for (const [provider, value] of Object.entries(override.defaults)) {
      if (!isRecord(value)) continue;
      const next: ProviderModelDefaults = { ...(catalog.defaults[provider] ?? {}) };
      for (const key of ["model", "subModel", "reasoningLevel", "subModelReasoningLevel"] as const) {
        if (typeof value[key] === "string") next[key] = value[key] as string;
      }
      catalog.defaults[provider] = next;
    }
  }
  return catalog;
}
