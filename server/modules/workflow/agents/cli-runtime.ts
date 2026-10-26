import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createStreamLineBuffer } from "../core/cli-tools.ts";
import { createCliStreamState, parseCliStreamLine } from "./cli-adapters/index.ts";

type CliRuntimeDeps = {
  db: any;
  logsDir: string;
  buildAgentArgs: (provider: string, model?: string, reasoningLevel?: string) => string[];
  clearCliOutputDedup: (taskId: string) => void;
  normalizeStreamChunk: (chunk: Buffer | string, options?: { dropCliNoise?: boolean }) => string;
  shouldSkipDuplicateCliOutput: (taskId: string, stream: "stdout" | "stderr", text: string) => boolean;
  broadcast: (event: string, payload: unknown) => void;
  TASK_RUN_IDLE_TIMEOUT_MS: number;
  TASK_RUN_HARD_TIMEOUT_MS: number;
  killPidTree: (pid: number) => void;
  appendTaskLog: (taskId: string | null, kind: string, message: string) => void;
  activeProcesses: Map<string, ChildProcess>;
  createSubtaskFromCli: (taskId: string, toolUseId: string, title: string) => void;
  completeSubtaskFromCli: (toolUseId: string) => void;
};

export function createCliRuntimeTools(deps: CliRuntimeDeps) {
  const {
    db,
    logsDir,
    buildAgentArgs,
    clearCliOutputDedup,
    normalizeStreamChunk,
    shouldSkipDuplicateCliOutput,
    broadcast,
    TASK_RUN_IDLE_TIMEOUT_MS,
    TASK_RUN_HARD_TIMEOUT_MS,
    killPidTree,
    appendTaskLog,
    activeProcesses,
    createSubtaskFromCli,
    completeSubtaskFromCli,
  } = deps;

  // Codex multi-agent: map thread_id → cli_tool_use_id (item.id from spawn_agent)
  const codexThreadToSubtask = new Map<string, string>();

  function parseAndCreateSubtasks(taskId: string, data: string): void {
    // Line formats are read by the per-CLI adapters; this only reacts to sub-agent events.
    const state = createCliStreamState();
    for (const line of data.split("\n")) {
      const events = parseCliStreamLine(line, state);
      if (!events) continue;
      for (const event of events) {
        try {
          switch (event.kind) {
            case "subagent_started": {
              const existing = dbPrepareSubtaskByToolUseId().get(event.id) as { id: string } | undefined;
              if (!existing) createSubtaskFromCli(taskId, event.id, event.title);
              break;
            }
            case "subagent_finished":
              completeSubtaskFromCli(event.id);
              break;
            case "subagent_thread_linked":
              codexThreadToSubtask.set(event.threadId, event.id);
              break;
            case "subagent_threads_closed":
              for (const tid of event.threadIds) {
                const origItemId = codexThreadToSubtask.get(tid);
                if (origItemId) {
                  completeSubtaskFromCli(origItemId);
                  codexThreadToSubtask.delete(tid);
                }
              }
              break;
            case "plan_subtasks":
              for (const title of event.titles) {
                const existing = dbPrepareOpenSubtaskByTitle().get(taskId, title) as { id: string } | undefined;
                if (!existing) {
                  const stId = `gemini-plan-${title.slice(0, 30).replace(/\s/g, "-")}-${Date.now()}`;
                  createSubtaskFromCli(taskId, stId, title);
                }
              }
              break;
            case "plan_subtask_done": {
              const sub = dbPrepareOpenSubtaskToolUseIdByTitle().get(taskId, event.title) as
                | { cli_tool_use_id: string }
                | undefined;
              if (sub) completeSubtaskFromCli(sub.cli_tool_use_id);
              break;
            }
            default:
              break;
          }
        } catch {
          // a failed subtask write must not break output streaming
        }
      }
    }
  }

  const dbPrepareSubtaskByToolUseId = () => db.prepare("SELECT id FROM subtasks WHERE cli_tool_use_id = ?");
  const dbPrepareOpenSubtaskByTitle = () =>
    db.prepare("SELECT id FROM subtasks WHERE task_id = ? AND title = ? AND status != 'done'");
  const dbPrepareOpenSubtaskToolUseIdByTitle = () =>
    db.prepare("SELECT cli_tool_use_id FROM subtasks WHERE task_id = ? AND title = ? AND status != 'done' LIMIT 1");

  function createSafeLogStreamOps(logStream: any): {
    safeWrite: (text: string) => boolean;
    safeEnd: (onDone?: () => void) => void;
    isClosed: () => boolean;
  } {
    let ended = false;
    const isClosed = () => ended || Boolean(logStream?.destroyed || logStream?.writableEnded || logStream?.closed);
    const safeWrite = (text: string): boolean => {
      if (!text || isClosed()) return false;
      try {
        logStream.write(text);
        return true;
      } catch {
        ended = true;
        return false;
      }
    };
    const safeEnd = (onDone?: () => void): void => {
      if (isClosed()) {
        ended = true;
        onDone?.();
        return;
      }
      ended = true;
      try {
        logStream.end(() => onDone?.());
      } catch {
        onDone?.();
      }
    };
    return { safeWrite, safeEnd, isClosed };
  }

  const CLI_PATH_FALLBACK_DIRS =
    process.platform === "win32"
      ? [
          path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
          path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs"),
          path.join(process.env.APPDATA || "", "npm"),
        ].filter(Boolean)
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          path.join(os.homedir(), ".local", "bin"),
          path.join(os.homedir(), "bin"),
        ];

  function withCliPathFallback(pathValue: string | undefined): string {
    const parts = (pathValue ?? "")
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean);
    const seen = new Set(parts);
    for (const dir of CLI_PATH_FALLBACK_DIRS) {
      if (!dir || seen.has(dir)) continue;
      parts.push(dir);
      seen.add(dir);
    }
    return parts.join(path.delimiter);
  }

  function spawnCliAgent(
    taskId: string,
    provider: string,
    prompt: string,
    projectPath: string,
    logPath: string,
    model?: string,
    reasoningLevel?: string,
  ): ChildProcess {
    clearCliOutputDedup(taskId);
    // Save prompt for debugging
    const promptPath = path.join(logsDir, `${taskId}.prompt.txt`);
    fs.writeFileSync(promptPath, prompt, "utf8");

    const args = buildAgentArgs(provider, model, reasoningLevel);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const { safeWrite, safeEnd } = createSafeLogStreamOps(logStream);
    safeWrite(`\n===== task run start ${new Date().toISOString()} | provider=${provider} =====\n`);

    // Remove CLAUDECODE env var to prevent "nested session" detection
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE;
    cleanEnv.PATH = withCliPathFallback(String(cleanEnv.PATH ?? process.env.PATH ?? ""));
    cleanEnv.NO_COLOR = "1";
    cleanEnv.FORCE_COLOR = "0";
    cleanEnv.CI = "1";
    if (!cleanEnv.TERM) cleanEnv.TERM = "dumb";

    const child = spawn(args[0], args.slice(1), {
      cwd: projectPath,
      env: cleanEnv,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let finished = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let stdoutListener: ((chunk: Buffer) => void) | null = null;
    let stderrListener: ((chunk: Buffer) => void) | null = null;
    const detachOutputListeners = () => {
      if (stdoutListener) {
        child.stdout?.off("data", stdoutListener);
        stdoutListener = null;
      }
      if (stderrListener) {
        child.stderr?.off("data", stderrListener);
        stderrListener = null;
      }
    };
    const clearRunTimers = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
    };
    const triggerTimeout = (kind: "idle" | "hard") => {
      if (finished) return;
      finished = true;
      clearRunTimers();
      const timeoutMs = kind === "idle" ? TASK_RUN_IDLE_TIMEOUT_MS : TASK_RUN_HARD_TIMEOUT_MS;
      const reason =
        kind === "idle"
          ? `no output for ${Math.round(timeoutMs / 1000)}s`
          : `exceeded max runtime ${Math.round(timeoutMs / 1000)}s`;
      const msg = `[Claw-Empire] RUN TIMEOUT (${reason})`;
      safeWrite(`\n${msg}\n`);
      appendTaskLog(taskId, "error", msg);
      try {
        if (child.pid && child.pid > 0) {
          killPidTree(child.pid);
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // ignore kill race
      }
    };
    const touchIdleTimer = () => {
      if (finished || TASK_RUN_IDLE_TIMEOUT_MS <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => triggerTimeout("idle"), TASK_RUN_IDLE_TIMEOUT_MS);
    };

    touchIdleTimer();
    if (TASK_RUN_HARD_TIMEOUT_MS > 0) {
      hardTimer = setTimeout(() => triggerTimeout("hard"), TASK_RUN_HARD_TIMEOUT_MS);
    }

    activeProcesses.set(taskId, child);

    child.on("error", (err) => {
      finished = true;
      clearRunTimers();
      detachOutputListeners();
      console.error(`[Claw-Empire] spawn error for ${provider} (task ${taskId}): ${err.message}`);
      safeWrite(`\n[Claw-Empire] SPAWN ERROR: ${err.message}\n`);
      safeEnd();
      activeProcesses.delete(taskId);
      appendTaskLog(taskId, "error", `Agent spawn failed: ${err.message}`);
    });

    // Deliver prompt via stdin (cross-platform safe)
    child.stdin?.write(prompt);
    child.stdin?.end();

    // Pipe agent output to log file AND broadcast via WebSocket, one whole line at a time.
    const stdoutLines = createStreamLineBuffer();
    const stderrLines = createStreamLineBuffer();
    const emitStdout = (raw: string) => {
      const text = normalizeStreamChunk(raw, { dropCliNoise: true });
      if (!text) return;
      if (shouldSkipDuplicateCliOutput(taskId, "stdout", text)) return;
      safeWrite(text);
      broadcast("cli_output", { task_id: taskId, stream: "stdout", data: text });
      parseAndCreateSubtasks(taskId, text);
    };
    const emitStderr = (raw: string) => {
      const text = normalizeStreamChunk(raw, { dropCliNoise: true });
      if (!text) return;
      if (shouldSkipDuplicateCliOutput(taskId, "stderr", text)) return;
      safeWrite(text);
      broadcast("cli_output", { task_id: taskId, stream: "stderr", data: text });
    };
    stdoutListener = (chunk: Buffer) => {
      touchIdleTimer();
      emitStdout(stdoutLines.push(chunk));
    };
    stderrListener = (chunk: Buffer) => {
      touchIdleTimer();
      emitStderr(stderrLines.push(chunk));
    };
    child.stdout?.on("data", stdoutListener);
    child.stderr?.on("data", stderrListener);

    child.on("close", () => {
      finished = true;
      clearRunTimers();
      detachOutputListeners();
      emitStdout(stdoutLines.flush());
      emitStderr(stderrLines.flush());
      safeEnd();
      try {
        fs.unlinkSync(promptPath);
      } catch {
        /* ignore */
      }
    });

    if (process.platform !== "win32") child.unref();

    return child;
  }

  return {
    codexThreadToSubtask,
    spawnCliAgent,
  };
}
