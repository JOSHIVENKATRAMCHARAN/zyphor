import { NextRequest } from "next/server";

type TurnstileResponse = {
  success?: boolean;
  hostname?: string;
  "error-codes"?: string[];
};

export function shouldEnforceTurnstile(): boolean {
  if (process.env.TURNSTILE_ENFORCE === "true") return true;
  if (process.env.TURNSTILE_ENFORCE === "false") return false;
  return process.env.NODE_ENV === "production";
}

/**
 * Validates a token with Cloudflare siteverify endpoint.
 */
export async function verifyTurnstile(token: unknown, request?: NextRequest): Promise<boolean> {
  if (!shouldEnforceTurnstile()) return true;
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    console.warn("[turnstile] Invalid token format or empty token received.");
    return false;
  }

  const secret =
    process.env.TURNSTILE_SECRET_KEY ||
    process.env.TURNSTILE_SECRET;

  if (!secret) {
    console.error("[turnstile] TURNSTILE_SECRET_KEY / TURNSTILE_SECRET is missing; refusing request.");
    return false;
  }

  const body = new URLSearchParams({ secret, response: token });

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });

    if (!response.ok) {
      console.error(`[turnstile] Cloudflare siteverify HTTP error: ${response.status}`);
      return false;
    }

    const result = (await response.json()) as TurnstileResponse;
    if (!result.success) {
      console.warn("[turnstile] Cloudflare rejected token:", result["error-codes"] || "unknown error");
      return false;
    }

    const currentHost = (
      request?.headers.get("x-forwarded-host") ||
      request?.headers.get("host") ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      process.env.VERCEL_URL ||
      ""
    ).toLowerCase();

    const configuredHostnames = (
      process.env.TURNSTILE_HOSTNAMES ||
      process.env.TURNSTILE_EXPECTED_HOSTNAME ||
      "zyphor-psi.vercel.app,localhost,127.0.0.1"
    )
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    if (result.hostname) {
      const challengeHost = result.hostname.toLowerCase();
      const isConfigured = configuredHostnames.includes(challengeHost);
      const isCurrentHost = currentHost && (challengeHost === currentHost || challengeHost.endsWith(".vercel.app"));
      const isLocal = challengeHost === "localhost" || challengeHost === "127.0.0.1";

      if (!isConfigured && !isCurrentHost && !isLocal) {
        console.warn(
          `[turnstile] Hostname mismatch: received "${result.hostname}", expected one of [${configuredHostnames.join(", ")}] or current "${currentHost}"`
        );
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error("[turnstile] Verification exception:", error);
    return false;
  }
}
