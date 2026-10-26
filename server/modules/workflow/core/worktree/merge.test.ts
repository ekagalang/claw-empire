import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeLifecycleTools } from "./lifecycle.ts";
import { createWorktreeMergeTools } from "./merge.ts";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 15000 }).toString().trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-merge-"));
  try {
    runGit(dir, ["init", "-b", "main"]);
  } catch {
    runGit(dir, ["init"]);
    runGit(dir, ["checkout", "-B", "main"]);
  }
  runGit(dir, ["config", "user.name", "Claw-Empire Test"]);
  runGit(dir, ["config", "user.email", "claw-empire-test@example.local"]);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n", "utf8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "seed"]);
  return dir;
}

function setup(repo: string, taskId: string) {
  const taskWorktrees = new Map();
  const lifecycle = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
  const merge = createWorktreeMergeTools({
    db: { prepare: () => ({ get: () => ({ title: "Test task", description: "" }) }) },
    taskWorktrees,
    appendTaskLog: () => {},
    cleanupWorktree: lifecycle.cleanupWorktree,
    resolveLang: () => "en",
    l: (_ko: string[], en: string[]) => en,
    pickL: (value: string[]) => value[0] ?? "",
  });
  const worktreePath = String(lifecycle.createWorktree(repo, taskId, "Tester"));
  return { lifecycle, merge, worktreePath, taskWorktrees };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("worktree merge safety", () => {
  it("refuses to merge into a checkout with uncommitted changes", () => {
    const repo = initRepo();
    tempDirs.push(repo);
    const taskId = "dirty001-0000-0000-0000-000000000000";
    const { merge, worktreePath } = setup(repo, taskId);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "agent change\n", "utf8");
    fs.writeFileSync(path.join(repo, "README.md"), "user edit in progress\n", "utf8");

    const result = merge.mergeWorktree(repo, taskId);

    expect(result.success).toBe(false);
    expect(result.message).toContain("uncommitted changes");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("user edit in progress\n");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
  });

  it("keeps the branch for manual review without touching the checkout", () => {
    const repo = initRepo();
    tempDirs.push(repo);
    const taskId = "manual01-0000-0000-0000-000000000000";
    const { merge, worktreePath } = setup(repo, taskId);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "agent change\n", "utf8");
    const mainBefore = runGit(repo, ["rev-parse", "main"]);

    const result = merge.keepBranchForManualReview(taskId);

    expect(result.success).toBe(true);
    expect(result.message).toContain("climpire/manual01");
    expect(runGit(repo, ["rev-parse", "main"])).toBe(mainBefore);
    expect(runGit(repo, ["show", "climpire/manual01:feature.txt"])).toBe("agent change");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
  });
});
