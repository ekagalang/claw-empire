/**
 * Per-session allowlist of messenger user IDs that may talk to agents.
 *
 * Agents run without permission prompts, so in a group chat or a Discord channel every
 * member could otherwise steer them. Sessions store `allowedSenderIds` as an array (or a
 * comma/newline separated string from older clients).
 */
export function parseAllowedSenderIds(raw: unknown): Set<string> {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  const out = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === "number" ? String(Math.trunc(value)) : String(value ?? "").trim();
    if (/^-?\d{1,32}$/.test(normalized)) out.add(normalized.replace(/^-/, ""));
  }
  return out;
}

const warnedTargets = new Set<string>();

export function warnMissingSenderAllowlist(channel: string, targetId: string): void {
  const key = `${channel}:${targetId}`;
  if (warnedTargets.has(key)) return;
  warnedTargets.add(key);
  console.warn(
    `[Claw-Empire] Ignoring ${channel} messages in ${targetId}: the session has no allowed sender IDs. ` +
      "Add your user ID under Settings > Channel Messages to let it drive agents.",
  );
}

export function isSenderAllowed(allowed: Set<string>, senderId: unknown): boolean {
  if (allowed.size === 0) return false;
  const normalized = typeof senderId === "number" ? String(Math.trunc(senderId)) : String(senderId ?? "").trim();
  return normalized.length > 0 && allowed.has(normalized.replace(/^-/, ""));
}
