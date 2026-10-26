import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeLifecycleTools } from "./lifecycle.ts";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 15000 }).toString().trim();
}

function initRepo(basePrefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), basePrefix));
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

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree lifecycle branch collision handling", () => {
  it("reuses existing task branch when branch already exists", () => {
    const repo = initRepo("climpire-wt-reuse-");
    tempDirs.push(repo);
    const shortId = "reuse001";
    const taskId = `${shortId}-0000-0000-0000-000000000000`;
    runGit(repo, ["branch", `climpire/${shortId}`]);

    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();
    const info = taskWorktrees.get(taskId);
    expect(info?.branchName).toBe(`climpire/${shortId}`);
    expect(fs.existsSync(String(info?.worktreePath || ""))).toBe(true);

    tools.cleanupWorktree(repo, taskId);
    expect(taskWorktrees.has(taskId)).toBe(false);
  });

  it("falls back to suffixed branch when existing branch is occupied in another worktree", () => {
    const repo = initRepo("climpire-wt-fallback-");
    tempDirs.push(repo);
    const shortId = "fallback";
    const baseBranch = `climpire/${shortId}`;
    const occupiedPath = path.join(repo, ".occupied-worktree");
    runGit(repo, ["worktree", "add", occupiedPath, "-b", baseBranch, "HEAD"]);

    const taskId = `${shortId}-0000-0000-0000-000000000000`;
    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();
    const info = taskWorktrees.get(taskId);
    expect(info?.branchName.startsWith(baseBranch)).toBe(true);
    expect(info?.branchName).not.toBe(baseBranch);

    tools.cleanupWorktree(repo, taskId);
    runGit(repo, ["worktree", "remove", occupiedPath, "--force"]);
    runGit(repo, ["branch", "-D", baseBranch]);
  });
});

describe("worktree recovery across restarts", { timeout: 20_000 }, () => {
  it("reuses the task's existing worktree instead of deleting uncommitted work", () => {
    const repo = initRepo("climpire-wt-resume-");
    tempDirs.push(repo);
    const taskId = "resume01-0000-0000-0000-000000000000";

    const first = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees: new Map() });
    const worktreePath = first.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();
    fs.writeFileSync(path.join(String(worktreePath), "work.txt"), "uncommitted agent work\n", "utf8");

    // Simulate a server restart: the in-memory task→worktree map is empty.
    const taskWorktrees = new Map();
    const restarted = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
    const recovered = restarted.recoverTaskWorktree(repo, taskId);
    expect(recovered?.branchName).toBe("climpire/resume01");
    expect(fs.realpathSync.native(String(recovered?.worktreePath))).toBe(fs.realpathSync.native(String(worktreePath)));

    const again = restarted.createWorktree(repo, taskId, "Tester");
    expect(fs.realpathSync.native(String(again))).toBe(fs.realpathSync.native(String(worktreePath)));
    expect(fs.readFileSync(path.join(String(again), "work.txt"), "utf8")).toContain("uncommitted agent work");

    restarted.cleanupWorktree(repo, taskId);
  });

  it("returns null when the task has no worktree", () => {
    const repo = initRepo("climpire-wt-none-");
    tempDirs.push(repo);
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees: new Map() });
    expect(tools.recoverTaskWorktree(repo, "nothere0-0000-0000-0000-000000000000")).toBeNull();
  });
});
