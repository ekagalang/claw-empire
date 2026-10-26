import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { initializeCollabCoordination } from "./coordination.ts";

function setup(projectPaths: string[] = []) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, project_path TEXT)");
  projectPaths.forEach((p, i) => db.prepare("INSERT INTO projects (id, project_path) VALUES (?, ?)").run(`p${i}`, p));
  return initializeCollabCoordination({ db } as unknown as RuntimeContext) as {
    detectProjectPath: (message: string) => string | null;
    resolveProjectPath: (task: { description?: string | null; title?: string }) => string;
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("project path detection from free text", () => {
  it("ignores the filesystem root and the home directory", () => {
    const { detectProjectPath } = setup();
    expect(detectProjectPath("please clean up / for me")).toBeNull();
    expect(detectProjectPath("check everything in ~/. please")).toBeNull();
  });

  it("does not fall back to the Claw-Empire checkout when nothing is detected", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claw-workspace-"));
    tempDirs.push(workspace);
    const previous = process.env.AGENT_DEFAULT_WORKSPACE;
    process.env.AGENT_DEFAULT_WORKSPACE = workspace;
    try {
      const { resolveProjectPath } = setup();
      const resolved = resolveProjectPath({ title: "no path here", description: "" });
      expect(path.resolve(resolved)).toBe(path.resolve(workspace));
      expect(path.resolve(resolved)).not.toBe(path.resolve(process.cwd()));
    } finally {
      if (previous === undefined) delete process.env.AGENT_DEFAULT_WORKSPACE;
      else process.env.AGENT_DEFAULT_WORKSPACE = previous;
    }
  });

  it.skipIf(process.platform === "win32")("accepts paths inside a registered project only", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claw-outside-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "claw-project-"));
    tempDirs.push(outside, project);
    fs.mkdirSync(path.join(project, "src"));
    const { detectProjectPath } = setup([project]);

    expect(detectProjectPath(`fix the bug in ${project}/src`)).toBe(path.join(project, "src"));
    expect(detectProjectPath(`look at ${outside}`)).toBeNull();
  });
});
