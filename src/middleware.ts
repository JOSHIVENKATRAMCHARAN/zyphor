import { NextRequest, NextResponse } from "next/server";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@/lib/csrf-shared";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_PROTECTED_PREFIXES = [
  "/api/upload",
  "/api/links",
  "/api/profile",
  "/api/webrtc",
  "/api/auth/register",
];
const middlewareRateLimits = new Map<string, number[]>();

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // Middleware instances are short-lived, but cap attacker-controlled key growth.
  if (middlewareRateLimits.size > 10_000 && !middlewareRateLimits.has(key)) {
    middlewareRateLimits.clear();
  }
  const attempts = (middlewareRateLimits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (attempts.length >= limit) {
    middlewareRateLimits.set(key, attempts);
    return true;
  }
  attempts.push(now);
  middlewareRateLimits.set(key, attempts);
  return false;
}

function isCsrfProtectedPath(pathname: string): boolean {
  return CSRF_PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function hasValidSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function newCsrfToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();
  const shouldProtect = isCsrfProtectedPath(pathname) && !SAFE_METHODS.has(method);
  const isApiMutation = pathname.startsWith("/api/") && !SAFE_METHODS.has(method);
  const isNextAuthRoute = pathname.startsWith("/api/auth/") && pathname !== "/api/auth/register";

  const csrfCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  const csrfHeader = request.headers.get(CSRF_HEADER_NAME);

  // All state-changing first-party APIs must originate from this site. NextAuth
  // validates its own CSRF token, while application APIs also use the token below.
  if (isApiMutation && !isNextAuthRoute && !hasValidSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  if (shouldProtect) {
    if (!hasValidSameOrigin(request)) {
      return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
    }

    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      return NextResponse.json({ error: "CSRF validation failed" }, { status: 403 });
    }
  }

  if (pathname.startsWith("/api/") && !isNextAuthRoute) {
    const isWebrtcPoll = pathname === "/api/webrtc/signal" && method === "GET";
    const isPublicTransfer = pathname.startsWith("/api/download/");
    const limit = isWebrtcPoll ? 1500 : isPublicTransfer ? 600 : SAFE_METHODS.has(method) ? 300 : 120;
    const key = `${clientIp(request)}:${method}:${pathname}`;
    if (isRateLimited(key, limit, 5 * 60_000)) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  const response = NextResponse.next();

  if (!csrfCookie) {
    response.cookies.set({
      name: CSRF_COOKIE_NAME,
      value: newCsrfToken(),
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: false,
      maxAge: 60 * 60 * 24 * 7,
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png).*)"],
};
