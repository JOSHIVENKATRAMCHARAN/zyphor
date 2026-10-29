import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function ensureProductionNextAuthUrl(req: NextRequest) {
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL;

  if (host && !host.includes("localhost")) {
    const proto = req.headers.get("x-forwarded-proto") || "https";
    process.env.NEXTAUTH_URL = `${proto}://${host}`;
  }
}

const handler = (req: NextRequest, ctx: any) => {
  ensureProductionNextAuthUrl(req);
  return NextAuth(authOptions)(req, ctx);
};

export { handler as GET, handler as POST };
