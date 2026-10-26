import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { decryptSecret } from "../../../oauth/helpers.ts";
import { isValidGitHubName, withGitHubTokenEnv } from "../../../security/git-credentials.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";

export type GitHubRouteDeps = Pick<RuntimeContext, "app" | "db" | "broadcast">;

export function registerGitHubRoutes(deps: GitHubRouteDeps): void {
  const { app, db, broadcast } = deps;

  function getGitHubAccessToken(): string | null {
    const row = db
      .prepare(
        "SELECT access_token_enc, scope FROM oauth_accounts WHERE provider = 'github' AND status = 'active' ORDER BY priority ASC, updated_at DESC LIMIT 1",
      )
      .get() as { access_token_enc: string | null; scope: string | null } | undefined;
    if (!row?.access_token_enc) return null;
    try {
      return decryptSecret(row.access_token_enc);
    } catch {
      return null;
    }
  }

  function hasRepoScope(scope: string | null | undefined): boolean {
    if (!scope) return false;
    if (scope.includes("github-app")) return true;
    return scope.split(/[\s,]+/).includes("repo");
  }

  const activeClones = new Map<
    string,
    { status: string; progress: number; error?: string; targetPath: string; repoFullName: string }
  >();

  app.get("/api/github/status", async (_req, res) => {
    const row = db
      .prepare(
        "SELECT id, email, scope, status, access_token_enc FROM oauth_accounts WHERE provider = 'github' AND status = 'active' ORDER BY priority ASC, updated_at DESC LIMIT 1",
      )
      .get() as
      | { id: string; email: string | null; scope: string | null; status: string; access_token_enc: string | null }
      | undefined;
    if (!row) return res.json({ connected: false, has_repo_scope: false });

    let repoScope = hasRepoScope(row.scope);
    if (!repoScope && row.access_token_enc) {
      try {
        const token = decryptSecret(row.access_token_enc);
        const authHeaders = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };

        const probe = await fetch("https://api.github.com/user", {
          headers: authHeaders,
          signal: AbortSignal.timeout(8000),
        });
        const actualScopes = probe.headers.get("x-oauth-scopes");

        if (probe.ok && typeof actualScopes === "string" && actualScopes.length > 0) {
          db.prepare("UPDATE oauth_accounts SET scope = ?, updated_at = ? WHERE id = ?").run(
            actualScopes,
            Date.now(),
            row.id,
          );
          repoScope = hasRepoScope(actualScopes);
        } else if (probe.ok && (actualScopes === "" || actualScopes === null)) {
          try {
            const repoProbe = await fetch("https://api.github.com/user/repos?per_page=1&visibility=private", {
              headers: authHeaders,
              signal: AbortSignal.timeout(8000),
            });
            if (repoProbe.ok) {
              repoScope = true;
              db.prepare("UPDATE oauth_accounts SET scope = ?, updated_at = ? WHERE id = ?").run(
                "repo (github-app)",
                Date.now(),
                row.id,
              );
            }
          } catch {
            // private repo 접근 체크 실패는 무시하고 기존 결과 유지
          }
        }
      } catch (probeErr) {
        console.error("[GitHub Status] probe error:", probeErr);
      }
    }

    res.json({
      connected: true,
      has_repo_scope: repoScope,
      email: row.email,
      account_id: row.id,
      scope: row.scope,
    });
  });

  app.get("/api/github/repos", async (req, res) => {
    const token = getGitHubAccessToken();
    if (!token) return res.status(401).json({ error: "github_not_connected" });
    const q = String(req.query.q || "").trim();
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const perPage = Math.min(50, Math.max(1, parseInt(String(req.query.per_page || "30"), 10)));
    try {
      let url: string;
      if (q) {
        url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+user:@me&per_page=${perPage}&page=${page}&sort=updated`;
      } else {
        url = `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`;
      }
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return res.status(resp.status).json({ error: "github_api_error", status: resp.status, detail: body });
      }
      const json = await resp.json();
      const repos = q ? ((json as any).items ?? []) : json;
      res.json({
        repos: (repos as any[]).map((r: any) => ({
          id: r.id,
          name: r.name,
          full_name: r.full_name,
          owner: r.owner?.login,
          private: r.private,
          description: r.description,
          default_branch: r.default_branch,
          updated_at: r.updated_at,
          html_url: r.html_url,
          clone_url: r.clone_url,
        })),
      });
    } catch (err) {
      res.status(502).json({ error: "github_fetch_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/github/repos/:owner/:repo/branches", async (req, res) => {
    const pat = typeof req.headers["x-github-pat"] === "string" ? req.headers["x-github-pat"].trim() : null;
    const token = pat || getGitHubAccessToken();
    if (!token) return res.status(401).json({ error: "github_not_connected" });
    const { owner, repo } = req.params;
    const authHeader = pat ? `token ${token}` : `Bearer ${token}`;
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
        {
          headers: {
            Authorization: authHeader,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!resp.ok) {
        if (resp.status === 404) {
          return res.status(404).json({
            error: "repo_not_found",
            message: `Repository ${owner}/${repo} not found or not accessible with current token`,
          });
        }
        if (resp.status === 401) {
          return res.status(401).json({ error: "token_invalid", message: "Token is invalid or expired" });
        }
        return res.status(resp.status).json({ error: "github_api_error", status: resp.status });
      }
      const branches = (await resp.json()) as any[];
      const repoResp = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
          headers: {
            Authorization: authHeader,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      const repoData = repoResp.ok ? ((await repoResp.json()) as any) : null;
      res.json({
        remote_branches: branches.map((b: any) => ({
          name: b.name,
          sha: b.commit?.sha,
          is_default: b.name === repoData?.default_branch,
        })),
        default_branch: repoData?.default_branch ?? null,
      });
    } catch (err) {
      res.status(502).json({ error: "github_fetch_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/github/clone", (req, res) => {
    const pat = typeof req.headers["x-github-pat"] === "string" ? req.headers["x-github-pat"].trim() : null;
    const token = pat || getGitHubAccessToken();
    if (!token) return res.status(401).json({ error: "github_not_connected" });
    const { owner, repo, branch, target_path } = req.body ?? {};
    if (!owner || !repo) return res.status(400).json({ error: "owner_and_repo_required" });
    if (!isValidGitHubName(owner) || !isValidGitHubName(repo)) {
      return res.status(400).json({ error: "invalid_owner_or_repo" });
    }
    if (branch !== undefined && branch !== null && branch !== "") {
      if (typeof branch !== "string" || branch.startsWith("-") || /[\s~^:?*[\\]|\.\.|@\{/.test(branch)) {
        return res.status(400).json({ error: "invalid_branch" });
      }
    }
    if (target_path !== undefined && target_path !== null && typeof target_path !== "string") {
      return res.status(400).json({ error: "invalid_target_path" });
    }

    const repoFullName = `${owner}/${repo}`;
    const defaultTarget = path.join(os.homedir(), "Projects", repo);
    let targetPath = target_path?.trim() || defaultTarget;
    if (targetPath === "~") targetPath = os.homedir();
    else if (targetPath.startsWith("~/")) targetPath = path.join(os.homedir(), targetPath.slice(2));

    if (fs.existsSync(targetPath) && fs.existsSync(path.join(targetPath, ".git"))) {
      return res.json({ clone_id: null, already_exists: true, target_path: targetPath });
    }

    const cloneId = randomUUID();
    activeClones.set(cloneId, { status: "cloning", progress: 0, targetPath, repoFullName });

    // The token is passed per invocation via env, so it is not persisted in the clone's .git/config.
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    const args = ["clone", "--progress"];
    if (branch) {
      args.push("--branch", branch, "--single-branch");
    }
    args.push("--", cloneUrl, path.resolve(targetPath));

    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], env: withGitHubTokenEnv(token) });
    let stderrBuf = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/Receiving objects:\s+(\d+)%/);
      const resolveMatch = stderrBuf.match(/Resolving deltas:\s+(\d+)%/);
      let pct = 0;
      if (resolveMatch) pct = 50 + Math.floor(parseInt(resolveMatch[1], 10) / 2);
      else if (match) pct = Math.floor(parseInt(match[1], 10) / 2);
      const entry = activeClones.get(cloneId);
      if (entry) {
        entry.progress = pct;
      }
      broadcast("clone_progress", { clone_id: cloneId, progress: pct, status: "cloning" });
    });

    child.on("close", (code) => {
      const entry = activeClones.get(cloneId);
      if (entry) {
        if (code === 0) {
          entry.status = "done";
          entry.progress = 100;
          broadcast("clone_progress", { clone_id: cloneId, progress: 100, status: "done" });
        } else {
          entry.status = "error";
          entry.error = `git clone exited with code ${code}: ${stderrBuf.slice(-500)}`;
          broadcast("clone_progress", {
            clone_id: cloneId,
            progress: entry.progress,
            status: "error",
            error: entry.error,
          });
        }
      }
    });

    child.on("error", (err) => {
      const entry = activeClones.get(cloneId);
      if (entry) {
        entry.status = "error";
        entry.error = err.message;
        broadcast("clone_progress", { clone_id: cloneId, progress: 0, status: "error", error: err.message });
      }
    });

    res.json({ clone_id: cloneId, target_path: targetPath });
  });

  app.get("/api/github/clone/:cloneId", (req, res) => {
    const entry = activeClones.get(req.params.cloneId);
    if (!entry) return res.status(404).json({ error: "clone_not_found" });
    res.json({ clone_id: req.params.cloneId, ...entry });
  });

  app.get("/api/projects/:id/branches", (req, res) => {
    const project = db.prepare("SELECT id, project_path FROM projects WHERE id = ?").get(req.params.id) as
      | { id: string; project_path: string }
      | undefined;
    if (!project) return res.status(404).json({ error: "project_not_found" });
    try {
      const raw = execFileSync("git", ["branch", "-a", "--no-color"], {
        cwd: project.project_path,
        stdio: "pipe",
        timeout: 10000,
      }).toString();
      const lines = raw
        .split("\n")
        .map((l: string) => l.trim())
        .filter(Boolean);
      const current = lines.find((l: string) => l.startsWith("* "))?.replace("* ", "") ?? null;
      const branches = lines.map((l: string) => l.replace(/^\*\s+/, ""));
      res.json({ branches, current_branch: current });
    } catch (err) {
      res.status(500).json({ error: "git_branch_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });
}
