import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizePathEnv } from "./runtime.ts";

/**
 * Working directory for agent runs that have no project path.
 *
 * Previously these runs fell back to process.cwd(), i.e. the Claw-Empire checkout itself,
 * which holds .env secrets and the server code nodemon hot-reloads. Agents run without
 * permission prompts, so they now get a dedicated, otherwise empty directory instead.
 */
export function getDefaultAgentWorkspace(): string {
  const configured = normalizePathEnv(process.env.AGENT_DEFAULT_WORKSPACE);
  const workspace = path.resolve(configured || path.join(os.homedir(), "claw-empire-workspace"));
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}
