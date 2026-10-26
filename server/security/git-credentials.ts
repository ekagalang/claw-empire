/**
 * Supply a GitHub token to a single git invocation without writing it anywhere.
 *
 * The token travels as an `http.<url>.extraHeader` set through GIT_CONFIG_* environment
 * variables, so it never lands in `.git/config`, in remote URLs, in argv (visible to other
 * local processes), or in git's error output.
 */
export function withGitHubTokenEnv(token: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  env[`GIT_CONFIG_KEY_${index}`] = "http.https://github.com/.extraHeader";
  env[`GIT_CONFIG_VALUE_${index}`] = `AUTHORIZATION: basic ${basic}`;
  env.GIT_CONFIG_COUNT = String(index + 1);
  return env;
}

/** Remove userinfo (e.g. a token persisted by older versions) from an https remote URL. */
export function stripUrlCredentials(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return remoteUrl;
    if (!url.username && !url.password) return remoteUrl;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function isValidGitHubName(value: unknown): value is string {
  return typeof value === "string" && GITHUB_NAME.test(value) && value !== "." && value !== "..";
}
