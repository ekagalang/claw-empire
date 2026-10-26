import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_CATALOG, getModelCacheTtlMs, loadModelCatalog } from "./model-catalog.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function writeCatalog(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-model-catalog-"));
  tempDirs.push(dir);
  const file = path.join(dir, "model-catalog.json");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

describe("model catalog", () => {
  it("falls back to the built-in catalog when there is no override file", () => {
    const catalog = loadModelCatalog(path.join(os.tmpdir(), "does-not-exist", "model-catalog.json"));
    expect(catalog).toEqual(BUILTIN_MODEL_CATALOG);
  });

  it("uses Claude's always-current aliases as defaults", () => {
    expect(BUILTIN_MODEL_CATALOG.defaults.claude).toEqual({ model: "opus", subModel: "sonnet" });
    expect(BUILTIN_MODEL_CATALOG.cli.claude.slice(0, 3).map((m) => m.slug)).toEqual(["opus", "sonnet", "haiku"]);
  });

  it("lets an override file replace provider lists and merge defaults", () => {
    const file = writeCatalog(
      JSON.stringify({
        cli: { codex: ["gpt-6-codex", { slug: "gpt-6-mini", displayName: "GPT-6 mini" }] },
        oauth: { copilot: ["github-copilot/next-model"] },
        defaults: { codex: { model: "gpt-6-codex" }, newcli: { model: "x" } },
      }),
    );
    const catalog = loadModelCatalog(file);
    expect(catalog.cli.codex).toEqual([{ slug: "gpt-6-codex" }, { slug: "gpt-6-mini", displayName: "GPT-6 mini" }]);
    expect(catalog.cli.claude).toEqual(BUILTIN_MODEL_CATALOG.cli.claude);
    expect(catalog.oauth.copilot).toEqual(["github-copilot/next-model"]);
    expect(catalog.defaults.codex).toEqual({ ...BUILTIN_MODEL_CATALOG.defaults.codex, model: "gpt-6-codex" });
    expect(catalog.defaults.newcli).toEqual({ model: "x" });
    // The built-in catalog itself is never mutated by an override.
    expect(BUILTIN_MODEL_CATALOG.defaults.codex.model).toBe("gpt-5.3-codex");
  });

  it("ignores an invalid override file", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadModelCatalog(writeCatalog("{ not json"))).toEqual(BUILTIN_MODEL_CATALOG);
  });

  it("reads the cache TTL from MODEL_CACHE_TTL_MS", () => {
    vi.stubEnv("MODEL_CACHE_TTL_MS", "60000");
    expect(getModelCacheTtlMs()).toBe(60000);
    vi.stubEnv("MODEL_CACHE_TTL_MS", "nonsense");
    expect(getModelCacheTtlMs()).toBe(6 * 60 * 60 * 1000);
  });
});
