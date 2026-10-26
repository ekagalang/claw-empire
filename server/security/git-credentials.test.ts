import { describe, expect, it } from "vitest";
import { isValidGitHubName, stripUrlCredentials, withGitHubTokenEnv } from "./git-credentials.ts";

describe("withGitHubTokenEnv", () => {
  it("passes the token as an extra header through GIT_CONFIG_* env vars", () => {
    const env = withGitHubTokenEnv("ghs_secret", { PATH: "/bin" });
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    const basic = Buffer.from("x-access-token:ghs_secret").toString("base64");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${basic}`);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.PATH).toBe("/bin");
  });

  it("appends after existing GIT_CONFIG_* entries", () => {
    const env = withGitHubTokenEnv("t", { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a", GIT_CONFIG_KEY_1: "b" });
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe("a");
    expect(env.GIT_CONFIG_KEY_2).toBe("http.https://github.com/.extraHeader");
  });
});

describe("stripUrlCredentials", () => {
  it("removes a persisted token from https remotes", () => {
    expect(stripUrlCredentials("https://x-access-token:ghs_abc@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  it("leaves clean and non-https remotes alone", () => {
    expect(stripUrlCredentials("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(stripUrlCredentials("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });
});

describe("isValidGitHubName", () => {
  it("accepts owner/repo names and rejects option-like or traversal values", () => {
    expect(isValidGitHubName("GreenSheep01201")).toBe(true);
    expect(isValidGitHubName("claw-empire.v2")).toBe(true);
    expect(isValidGitHubName("..")).toBe(false);
    expect(isValidGitHubName("a/b")).toBe(false);
    expect(isValidGitHubName("x y")).toBe(false);
    expect(isValidGitHubName(42)).toBe(false);
  });
});
