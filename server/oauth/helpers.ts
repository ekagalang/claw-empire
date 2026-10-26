import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { OAUTH_BASE_HOST, PORT } from "../config/runtime.ts";

// ---------------------------------------------------------------------------
// OAuth encryption helpers
// ---------------------------------------------------------------------------
export const OAUTH_ENCRYPTION_SECRET = process.env.OAUTH_ENCRYPTION_SECRET || process.env.SESSION_SECRET || "";

function oauthEncryptionKey(): Buffer {
  if (!OAUTH_ENCRYPTION_SECRET) {
    throw new Error("Missing OAUTH_ENCRYPTION_SECRET");
  }
  return createHash("sha256").update(OAUTH_ENCRYPTION_SECRET, "utf8").digest();
}

export function encryptSecret(plaintext: string): string {
  const key = oauthEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  const [ver, ivB64, tagB64, ctB64] = payload.split(":");
  if (ver !== "v1" || !ivB64 || !tagB64 || !ctB64) throw new Error("invalid_encrypted_payload");
  const key = oauthEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString("utf8");
}

// ---------------------------------------------------------------------------
// OAuth web-auth constants & PKCE helpers
// ---------------------------------------------------------------------------
export const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || `http://${OAUTH_BASE_HOST}:${PORT}`;

// OAuth client credentials come only from the environment. Upstream shipped another product's
// GitHub and Google OAuth clients (including an obfuscated Google client secret) as built-in
// defaults; using them breaks those vendors' terms and can get accounts or the client revoked.
// Register your own OAuth apps and set OAUTH_GITHUB_CLIENT_ID / OAUTH_GOOGLE_CLIENT_ID /
// OAUTH_GOOGLE_CLIENT_SECRET to enable GitHub and Google (Antigravity) sign-in.
export const BUILTIN_GITHUB_CLIENT_ID = process.env.OAUTH_GITHUB_CLIENT_ID ?? "";
export const BUILTIN_GOOGLE_CLIENT_ID = process.env.OAUTH_GOOGLE_CLIENT_ID ?? "";
export const BUILTIN_GOOGLE_CLIENT_SECRET = process.env.OAUTH_GOOGLE_CLIENT_SECRET ?? "";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function pkceVerifier(): string {
  return b64url(randomBytes(32));
}

export async function pkceChallengeS256(verifier: string): Promise<string> {
  return b64url(createHash("sha256").update(verifier, "ascii").digest());
}

// ---------------------------------------------------------------------------
// OAuth helper functions
// ---------------------------------------------------------------------------
export function sanitizeOAuthRedirect(raw: string | undefined): string {
  if (!raw) return "/";
  try {
    const u = new URL(raw);
    if (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".ts.net")
    )
      return raw;
  } catch {
    // not absolute URL - treat as path
  }
  if (raw.startsWith("/")) return raw;
  return "/";
}

export function appendOAuthQuery(url: string, key: string, val: string): string {
  const u = new URL(url);
  u.searchParams.set(key, val);
  return u.toString();
}
