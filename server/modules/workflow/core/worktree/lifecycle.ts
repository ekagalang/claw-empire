import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type WorktreeInfo = {
  worktreePath: string;
  branchName: string;
  projectPath: string;
};

type CreateWorktreeLifecycleToolsDeps = {
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  taskWorktrees: Map<string, WorktreeInfo>;
};

export function createWorktreeLifecycleTools(deps: CreateWorktreeLifecycleToolsDeps) {
  const { appendTaskLog, taskWorktrees } = deps;

  function isGitRepo(dir: string): boolean {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  function ensureWorktreeBootstrapRepo(projectPath: string, taskId: string): boolean {
    if (isGitRepo(projectPath)) return true;
    const shortId = taskId.slice(0, 8);
    try {
      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        appendTaskLog(taskId, "system", `Git bootstrap skipped: invalid project path (${projectPath})`);
        return false;
      }
    } catch {
      appendTaskLog(taskId, "system", `Git bootstrap skipped: cannot access project path (${projectPath})`);
      return false;
    }

    try {
      appendTaskLog(
        taskId,
        "system",
        "Git repository not found. Bootstrapping local repository for worktree execution...",
      );

      try {
        execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: "pipe", timeout: 10000 });
      } catch {
        execFileSync("git", ["init"], { cwd: projectPath, stdio: "pipe", timeout: 10000 });
      }

      const excludePath = path.join(projectPath, ".git", "info", "exclude");
      const baseIgnore = ["node_modules/", "dist/", ".climpire-worktrees/", ".climpire/", ".DS_Store", "*.log"];
      let existingExclude = "";
      try {
        existingExclude = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
      } catch {
        existingExclude = "";
      }
      const appendLines = baseIgnore.filter((line) => !existingExclude.includes(line));
      if (appendLines.length > 0) {
        const prefix = existingExclude && !existingExclude.endsWith("\n") ? "\n" : "";
        fs.appendFileSync(excludePath, `${prefix}${appendLines.join("\n")}\n`, "utf8");
      }

      const readConfig = (key: string): string => {
        try {
          return execFileSync("git", ["config", "--get", key], { cwd: projectPath, stdio: "pipe", timeout: 3000 })
            .toString()
            .trim();
        } catch {
          return "";
        }
      };
      if (!readConfig("user.name")) {
        execFileSync("git", ["config", "user.name", "Claw-Empire Bot"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 3000,
        });
      }
      if (!readConfig("user.email")) {
        execFileSync("git", ["config", "user.email", "claw-empire@local"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 3000,
        });
      }

      execFileSync("git", ["add", "-A"], { cwd: projectPath, stdio: "pipe", timeout: 20000 });
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();
      if (staged) {
        execFileSync("git", ["commit", "-m", "chore: initialize project for Claw-Empire worktrees"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 20000,
        });
      } else {
        execFileSync("git", ["commit", "--allow-empty", "-m", "chore: initialize project for Claw-Empire worktrees"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 10000,
        });
      }

      appendTaskLog(taskId, "system", "Git repository initialized automatically for worktree execution.");
      console.log(`[Claw-Empire] Auto-initialized git repo for task ${shortId} at ${projectPath}`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTaskLog(taskId, "system", `Git bootstrap failed: ${msg}`);
      console.error(`[Claw-Empire] Failed git bootstrap for task ${shortId}: ${msg}`);
      return false;
    }
  }

  /**
   * Find this task's worktree from git itself, so the task→worktree mapping survives restarts
   * (taskWorktrees only lives in memory).
   */
  function findTaskWorktree(projectPath: string, taskId: string): WorktreeInfo | null {
    if (!isGitRepo(projectPath)) return null;
    const shortId = taskId.slice(0, 8);
    let porcelain = "";
    try {
      porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      }).toString();
    } catch {
      return null;
    }
    const branchPattern = new RegExp(`^refs/heads/(climpire/${shortId}(?:-\\d+)?)$`);
    const dirPattern = new RegExp(`^${shortId}(?:-\\d+)?$`);
    // realpath normalizes Windows 8.3 short names and casing so git's paths compare equal.
    const canonical = (p: string): string => {
      try {
        const real = fs.realpathSync.native(p);
        return process.platform === "win32" ? real.toLowerCase() : real;
      } catch {
        return "";
      }
    };
    const worktreeBase = canonical(path.resolve(projectPath, ".climpire-worktrees"));
    if (!worktreeBase) return null;
    for (const block of porcelain.split(/\r?\n\r?\n/)) {
      const worktreeLine = block.match(/^worktree (.+)$/m)?.[1]?.trim();
      const branchRef = block.match(/^branch (.+)$/m)?.[1]?.trim();
      const branchName = branchRef?.match(branchPattern)?.[1];
      if (!worktreeLine || !branchName) continue;
      const worktreePath = path.resolve(worktreeLine);
      // Only worktrees this app created for the task (<project>/.climpire-worktrees/<id8>[-n]).
      const realWorktree = canonical(worktreePath);
      if (!realWorktree || path.dirname(realWorktree) !== worktreeBase) continue;
      if (!dirPattern.test(path.basename(worktreePath))) continue;
      return { worktreePath, branchName, projectPath };
    }
    return null;
  }

  function recoverTaskWorktree(projectPath: string, taskId: string): WorktreeInfo | null {
    const known = taskWorktrees.get(taskId);
    if (known) return known;
    const found = findTaskWorktree(projectPath, taskId);
    if (found) taskWorktrees.set(taskId, found);
    return found;
  }

  function createWorktree(projectPath: string, taskId: string, agentName: string, baseBranch?: string): string | null {
    if (!ensureWorktreeBootstrapRepo(projectPath, taskId)) return null;
    if (!isGitRepo(projectPath)) return null;

    const shortId = taskId.slice(0, 8);
    const branchName = `climpire/${shortId}`;
    const worktreeBase = path.join(projectPath, ".climpire-worktrees");
    const worktreePath = path.join(worktreeBase, shortId);

    // Resume in the task's existing worktree (e.g. after a restart or re-run) instead of
    // deleting it, which used to discard the agent's uncommitted work.
    const existing = recoverTaskWorktree(projectPath, taskId);
    if (existing && fs.existsSync(existing.worktreePath)) {
      console.log(
        `[Claw-Empire] Reusing worktree for task ${shortId}: ${existing.worktreePath} (branch: ${existing.branchName}, agent: ${agentName})`,
      );
      return existing.worktreePath;
    }

    try {
      fs.mkdirSync(worktreeBase, { recursive: true });
      execFileSync("git", ["worktree", "prune"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });

      // Get current branch/HEAD as base
      let base: string;
      if (baseBranch) {
        try {
          base = execFileSync("git", ["rev-parse", baseBranch], { cwd: projectPath, stdio: "pipe", timeout: 5000 })
            .toString()
            .trim();
        } catch {
          base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath, stdio: "pipe", timeout: 5000 })
            .toString()
            .trim();
        }
      } else {
        base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath, stdio: "pipe", timeout: 5000 })
          .toString()
          .trim();
      }

      const branchCandidates = [branchName, `${branchName}-1`, `${branchName}-2`, `${branchName}-3`];
      let created = false;
      let selectedBranch = branchName;
      let selectedWorktreePath = worktreePath;
      let lastError: unknown = null;

      for (let idx = 0; idx < branchCandidates.length; idx += 1) {
        const candidateBranch = branchCandidates[idx]!;
        const candidatePath = idx === 0 ? worktreePath : path.join(worktreeBase, `${shortId}-${idx}`);
        try {
          if (fs.existsSync(candidatePath)) {
            fs.rmSync(candidatePath, { recursive: true, force: true });
          }
        } catch {
          // best effort cleanup
        }

        const branchExists = (() => {
          try {
            execFileSync("git", ["show-ref", "--verify", `refs/heads/${candidateBranch}`], {
              cwd: projectPath,
              stdio: "pipe",
              timeout: 5000,
            });
            return true;
          } catch {
            return false;
          }
        })();

        const addArgs = branchExists
          ? ["worktree", "add", candidatePath, candidateBranch]
          : ["worktree", "add", candidatePath, "-b", candidateBranch, base];

        try {
          execFileSync("git", addArgs, {
            cwd: projectPath,
            stdio: "pipe",
            timeout: 15000,
          });
          selectedBranch = candidateBranch;
          selectedWorktreePath = candidatePath;
          created = true;
          break;
        } catch (err: unknown) {
          lastError = err;
        }
      }

      if (!created) throw lastError instanceof Error ? lastError : new Error("worktree_add_failed");

      // Propagate .claude/skills into the worktree so agents can resolve installed skills
      try {
        const serverSkillsDir = path.join(process.cwd(), ".claude", "skills");
        if (fs.existsSync(serverSkillsDir)) {
          const wtClaudeDir = path.join(selectedWorktreePath, ".claude");
          const wtSkillsLink = path.join(wtClaudeDir, "skills");
          if (!fs.existsSync(wtSkillsLink)) {
            fs.mkdirSync(wtClaudeDir, { recursive: true });
            fs.symlinkSync(serverSkillsDir, wtSkillsLink, "junction");
          }
        }
      } catch {
        // best effort — skill propagation failure should not block execution
      }

      taskWorktrees.set(taskId, { worktreePath: selectedWorktreePath, branchName: selectedBranch, projectPath });
      console.log(
        `[Claw-Empire] Created worktree for task ${shortId}: ${selectedWorktreePath} (branch: ${selectedBranch}, agent: ${agentName})`,
      );
      return selectedWorktreePath;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Claw-Empire] Failed to create worktree for task ${shortId}: ${msg}`);
      return null;
    }
  }

  function cleanupWorktree(projectPath: string, taskId: string): void {
    const info = taskWorktrees.get(taskId);
    if (!info) return;

    const shortId = taskId.slice(0, 8);

    try {
      execFileSync("git", ["worktree", "remove", info.worktreePath, "--force"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 10000,
      });
    } catch {
      console.warn(`[Claw-Empire] git worktree remove failed for ${shortId}, falling back to manual cleanup`);
      try {
        if (fs.existsSync(info.worktreePath)) {
          fs.rmSync(info.worktreePath, { recursive: true, force: true });
        }
        execFileSync("git", ["worktree", "prune"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* ignore */
      }
    }

    try {
      execFileSync("git", ["branch", "-D", info.branchName], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      console.warn(`[Claw-Empire] Failed to delete branch ${info.branchName} — may need manual cleanup`);
    }

    taskWorktrees.delete(taskId);
    console.log(`[Claw-Empire] Cleaned up worktree for task ${shortId}`);
  }

  return {
    isGitRepo,
    createWorktree,
    cleanupWorktree,
    recoverTaskWorktree,
  };
}
