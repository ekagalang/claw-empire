import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket as WsSocket, WebSocketServer } from "ws";

interface RegisterGracefulShutdownHandlersOptions {
  activeProcesses: Map<string, ChildProcess>;
  stopRequestedTasks: Set<string>;
  killPidTree: (pid: number) => void;
  db: DatabaseSync;
  nowMs: () => number;
  endTaskExecutionSession: (taskId: string, reason: string) => void;
  wsClients: Set<WsSocket>;
  wss: WebSocketServer;
  server: { close: (callback: () => void) => void };
  onBeforeClose?: () => void;
}

export function registerGracefulShutdownHandlers({
  activeProcesses,
  stopRequestedTasks,
  killPidTree,
  db,
  nowMs,
  endTaskExecutionSession,
  wsClients,
  wss,
  server,
  onBeforeClose,
}: RegisterGracefulShutdownHandlersOptions): void {
  // Stop running agents without deleting their work: the worktree and branch are kept, and the
  // task goes back to the inbox so a re-run resumes in the same worktree.
  function stopActiveAgents(reason: string): void {
    for (const [taskId, child] of activeProcesses) {
      console.log(`[Claw-Empire] Stopping process for task ${taskId} (pid: ${child.pid})`);
      stopRequestedTasks.add(taskId);
      if (child.pid) {
        try {
          killPidTree(child.pid);
        } catch {
          // keep going; the process may already be gone
        }
      }
      activeProcesses.delete(taskId);

      try {
        const task = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
          | {
              assigned_agent_id: string | null;
            }
          | undefined;
        if (task?.assigned_agent_id) {
          db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
            task.assigned_agent_id,
          );
        }
        const t = nowMs();
        const moved = db
          .prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ? AND status = 'in_progress'")
          .run(t, taskId) as { changes?: number };
        if ((moved.changes ?? 0) > 0) {
          db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'system', ?, ?)").run(
            taskId,
            `Interrupted by ${reason}; worktree and branch kept. Run the task again to resume.`,
            t,
          );
        }
      } catch {
        // the database may already be closing
      }
      endTaskExecutionSession(taskId, reason);
    }
  }

  function gracefulShutdown(signal: string): void {
    console.log(`
[Claw-Empire] ${signal} received. Shutting down gracefully...`);

    try {
      onBeforeClose?.();
    } catch {
      // ignore pre-close cleanup failures
    }

    stopActiveAgents("server shutdown");

    for (const ws of wsClients) {
      ws.close(1001, "Server shutting down");
    }
    wsClients.clear();

    wss.close(() => {
      server.close(() => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        console.log("[Claw-Empire] Shutdown complete.");
        process.exit(0);
      });
    });

    setTimeout(() => {
      console.error("[Claw-Empire] Forced exit after timeout.");
      process.exit(1);
    }, 5000).unref();
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  process.once("SIGUSR2", () => {
    // nodemon restart: without this, detached agent CLIs kept running as orphans.
    stopActiveAgents("server restart");
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.kill(process.pid, "SIGUSR2");
  });
}
