import { NextRequest } from "next/server";

type TurnstileResponse = {
  success?: boolean;
  hostname?: string;
};

export function shouldEnforceTurnstile(): boolean {
  if (process.env.TURNSTILE_ENFORCE === "true") return true;
  if (process.env.TURNSTILE_ENFORCE === "false") return false;
  return process.env.NODE_ENV === "production";
}

/**
 * Validates a token with Cloudflare, so a value supplied by a browser cannot be
 * treated as proof of a solved challenge without Cloudflare's signed response.
 */
export async function verifyTurnstile(token: unknown, request?: NextRequest): Promise<boolean> {
  if (!shouldEnforceTurnstile()) return true;
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return false;

  const secret = process.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET;
  if (!secret) {
    console.error("TURNSTILE_SECRET_KEY / TURNSTILE_SECRET is missing; refusing protected requests.");
    return false;
  }

  const body = new URLSearchParams({ secret, response: token });
  const remoteIp = request?.headers.get("x-vercel-forwarded-for") || request?.headers.get("x-real-ip");
  if (remoteIp) body.set("remoteip", remoteIp.split(",")[0].trim());

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
    if (!response.ok) return false;

    const result = await response.json() as TurnstileResponse;
    if (!result.success) return false;

    const expectedHostname = process.env.TURNSTILE_EXPECTED_HOSTNAME?.trim().toLowerCase();
    const hostnames = process.env.TURNSTILE_HOSTNAMES
      ? process.env.TURNSTILE_HOSTNAMES.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
      : expectedHostname
      ? [expectedHostname]
      : [];

    if (hostnames.length > 0 && result.hostname) {
      return hostnames.includes(result.hostname.toLowerCase());
    }

    return true;
  } catch (error) {
    console.error("Turnstile verification failed:", error);
    return false;
  }
}
