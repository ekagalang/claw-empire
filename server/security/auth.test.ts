import express from "express";
import request from "supertest";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { SESSION_AUTH_TOKEN, SESSION_COOKIE_NAME } from "../config/runtime.ts";
import {
  bearerToken,
  buildTaskInterruptControlToken,
  cookieToken,
  csrfTokenFromRequest,
  getCsrfToken,
  getSessionCookieValue,
  hasValidCsrfToken,
  hasValidTaskInterruptControlToken,
  incomingMessageBearerToken,
  incomingMessageCookieToken,
  installSecurityMiddleware,
  isAuthenticated,
  isIncomingMessageAuthenticated,
  isIncomingMessageOriginTrusted,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  isPublicApiPath,
  isTrustedOrigin,
  issueSessionCookie,
  parseCookies,
  safeSecretEquals,
  shouldRequireCsrf,
  shouldUseSecureCookie,
} from "./auth.ts";

function mockRequest(headers: Record<string, string | undefined>): Request {
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    secure: false,
    socket: {
      remoteAddress: "127.0.0.1",
    },
  } as unknown as Request;
}

describe("auth helpers", () => {
  it("loopback 판별이 정확하다", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);

    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.2")).toBe(false);

    expect(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: "10.1.2.3" } })).toBe(false);
  });

  it("쿠키/토큰 파싱과 인증 판별이 동작한다", () => {
    const reqWithBearer = mockRequest({
      authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
    });
    expect(bearerToken(reqWithBearer)).toBe(SESSION_AUTH_TOKEN);
    expect(isAuthenticated(reqWithBearer)).toBe(true);

    const reqWithCookie = mockRequest({
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(getSessionCookieValue())}; foo=bar`,
    });
    expect(cookieToken(reqWithCookie)).toBe(getSessionCookieValue());
    expect(isAuthenticated(reqWithCookie)).toBe(true);

    // The raw API token is not a valid cookie, and the cookie value is not a valid bearer.
    expect(getSessionCookieValue()).not.toBe(SESSION_AUTH_TOKEN);
    expect(
      isAuthenticated(mockRequest({ cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}` })),
    ).toBe(false);
    expect(isAuthenticated(mockRequest({ authorization: `Bearer ${getSessionCookieValue()}` }))).toBe(false);

    const parsed = parseCookies("a=1; b=hello%20world; c=%E3%81%82");
    expect(parsed).toMatchObject({
      a: "1",
      b: "hello world",
      c: "あ",
    });
  });

  it("origin/path/secure-cookie 규칙을 판별한다", () => {
    expect(isTrustedOrigin("http://localhost:8800")).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:8790")).toBe(true);
    // Other local dev servers and arbitrary Tailscale Funnel hosts are not trusted.
    expect(isTrustedOrigin("http://localhost:5173")).toBe(false);
    expect(isTrustedOrigin("http://localhost")).toBe(false);
    expect(isTrustedOrigin("https://dev.ts.net")).toBe(false);
    expect(isTrustedOrigin("file://tmp/test")).toBe(false);
    expect(isTrustedOrigin("not-a-url")).toBe(false);

    expect(isPublicApiPath("/api/health")).toBe(true);
    expect(isPublicApiPath("/api/auth/session")).toBe(true);
    expect(isPublicApiPath("/api/openapi.json")).toBe(true);
    expect(isPublicApiPath("/api/docs")).toBe(true);
    expect(isPublicApiPath("/api/docs/")).toBe(true);
    expect(isPublicApiPath("/api/tasks")).toBe(false);

    const insecureReq = mockRequest({
      "x-forwarded-proto": "http",
    });
    expect(shouldUseSecureCookie(insecureReq)).toBe(false);

    const secureReq = {
      ...insecureReq,
      secure: true,
    } as Request;
    expect(shouldUseSecureCookie(secureReq)).toBe(true);
  });

  it("session cookie 발급 시 append를 호출하고 중복 발급은 방지한다", () => {
    const append = vi.fn();
    const res = { append } as unknown as Response;

    const reqNoCookie = mockRequest({
      cookie: undefined,
    });
    issueSessionCookie(reqNoCookie, res);
    expect(append).toHaveBeenCalledTimes(1);
    const firstCookie = String(append.mock.calls[0]?.[1] ?? "");
    expect(firstCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(firstCookie).toContain("HttpOnly");

    append.mockClear();
    expect(firstCookie).not.toContain(SESSION_AUTH_TOKEN);

    append.mockClear();
    const reqWithCookie = mockRequest({
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(getSessionCookieValue())}`,
    });
    issueSessionCookie(reqWithCookie, res);
    expect(append).not.toHaveBeenCalled();
  });

  it("IncomingMessage 인증/원본 판별이 동작한다", () => {
    const incoming = {
      headers: {
        authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(getSessionCookieValue())}`,
        origin: "http://localhost:8800",
      },
    } as unknown as IncomingMessage;

    expect(incomingMessageBearerToken(incoming)).toBe(SESSION_AUTH_TOKEN);
    expect(incomingMessageCookieToken(incoming)).toBe(getSessionCookieValue());
    expect(isIncomingMessageAuthenticated(incoming)).toBe(true);
    expect(isIncomingMessageOriginTrusted(incoming)).toBe(true);
  });

  it("safeSecretEquals는 값이 같을 때만 true다", () => {
    expect(safeSecretEquals("abc123", "abc123")).toBe(true);
    expect(safeSecretEquals("abc123", "abc124")).toBe(false);
    expect(safeSecretEquals("short", "much-longer")).toBe(false);
  });

  it("csrf / task-interrupt 제어 토큰 검증이 동작한다", () => {
    const csrf = getCsrfToken();
    const req = {
      ...mockRequest({
        "x-csrf-token": csrf,
      }),
      method: "POST",
    } as Request;
    expect(csrfTokenFromRequest(req)).toBe(csrf);
    expect(shouldRequireCsrf(req)).toBe(true);
    expect(hasValidCsrfToken(req)).toBe(true);

    const bearerReq = {
      ...mockRequest({
        authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
      }),
      method: "POST",
    } as Request;
    expect(shouldRequireCsrf(bearerReq)).toBe(false);

    const token = buildTaskInterruptControlToken("task-1", "session-1");
    expect(hasValidTaskInterruptControlToken("task-1", "session-1", token)).toBe(true);
    expect(hasValidTaskInterruptControlToken("task-1", "session-1", `${token}x`)).toBe(false);
  });
});

describe("installSecurityMiddleware", () => {
  it("세션 발급 후 보호 API 접근을 허용한다", async () => {
    const app = express();
    installSecurityMiddleware(app);
    app.get("/api/protected", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/api/protected").expect(401);

    const sessionRes = await request(app).get("/api/auth/session").expect(200);
    const cookieHeader = sessionRes.headers["set-cookie"]?.[0];
    expect(cookieHeader).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(sessionRes.body?.csrf_token).toBeTypeOf("string");

    await request(app).get("/api/protected").set("Cookie", String(cookieHeader)).expect(200, { ok: true });
  });

  it("세션 자동 발급은 진짜 로컬 요청에만 허용한다", async () => {
    const app = express();
    installSecurityMiddleware(app);

    // DNS rebinding: loopback socket but attacker-controlled Host header.
    await request(app).get("/api/auth/session").set("Host", "evil.example:8790").expect(401);
    // LAN access through the Vite proxy keeps the LAN Host header.
    await request(app).get("/api/auth/session").set("Host", "192.168.1.20:8800").expect(401);
    // A same-host reverse proxy reports the real client.
    await request(app).get("/api/auth/session").set("X-Forwarded-For", "203.0.113.7").expect(401);
    await request(app).get("/api/auth/session").set("X-Real-IP", "203.0.113.7").expect(401);
    await request(app).get("/api/auth/session").set("Forwarded", "for=203.0.113.7").expect(401);

    await request(app).get("/api/auth/session").set("Host", "localhost:8800").expect(200);
    await request(app).get("/api/auth/session").set("X-Forwarded-For", "127.0.0.1").expect(200);
    await request(app)
      .get("/api/auth/session")
      .set("Host", "evil.example:8790")
      .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
      .expect(200);
  });

  it("허용되지 않은 localhost 포트의 Origin을 거부한다", async () => {
    const app = express();
    installSecurityMiddleware(app);
    await request(app).get("/api/auth/session").set("Origin", "http://localhost:5173").expect(403);
    await request(app).get("/api/auth/session").set("Origin", "http://localhost:8800").expect(200);
  });
});
