import { AuthOptions, getServerSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import GithubProvider from "next-auth/providers/github";
import { prisma } from "@/lib/db";
import crypto from "crypto";
import { checkRateLimit, clearRateLimit } from "@/lib/rate-limit";
import { getAvatarFromSupabaseUser, getNameFromSupabaseUser, isSupabaseAuthConfigured, supabaseSignInWithPassword } from "@/lib/supabase-auth";
import { isValidEmail, normalizeEmail } from "@/lib/security";
import { verifyTurnstile } from "@/lib/turnstile";
import { databaseUnavailableMessage, isPrismaDatabaseConnectivityError, isPrismaSchemaMissingError, schemaMissingMessage } from "@/lib/prisma-errors";

if (
  process.env.VERCEL_URL &&
  (!process.env.NEXTAUTH_URL || process.env.NEXTAUTH_URL.includes("localhost"))
) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  process.env.NEXTAUTH_URL = `https://${host}`;
}

function sanitizeDisplayName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().slice(0, 80);
  return value || null;
}

function sanitizeAvatarUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value || value.length > 2048) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export const authOptions: AuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    }),
    GithubProvider({
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    }),
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        turnstileToken: { label: "Turnstile Token", type: "text" }
      },
      async authorize(credentials, request) {
        const rawEmail = credentials?.email || "";
        const password = credentials?.password || "";
        const turnstileToken = credentials?.turnstileToken;
        const email = normalizeEmail(rawEmail);

        if (!email || !password || !isValidEmail(email)) return null;

        // Rate Limiter: maximum of 5 attempts per 15 minutes per email to prevent vertical brute force
        const loginIp =
          request?.headers?.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
          request?.headers?.get("x-real-ip") ||
          request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          "unknown";
        const emailAllowed = await checkRateLimit(email, "login_attempt_email", 5, 15);
        const ipAllowed = await checkRateLimit(loginIp, "login_attempt_ip", 20, 15);
        if (!emailAllowed || !ipAllowed) {
          throw new Error("Too many failed login attempts. Please try again later.");
        }

        const turnstileOk = await verifyTurnstile(turnstileToken);
        if (!turnstileOk) {
          throw new Error("CAPTCHA validation failed.");
        }

        try {
          if (isSupabaseAuthConfigured()) {
            const authResult = await supabaseSignInWithPassword({
              email,
              password,
              captchaToken: turnstileToken,
            });

            if (authResult.ok) {
              let dbUser = await prisma.user.findUnique({
                where: { email },
              });

              const name = getNameFromSupabaseUser(authResult.user);
              const avatar = getAvatarFromSupabaseUser(authResult.user);
              const safeName = sanitizeDisplayName(name);
              const safeAvatar = sanitizeAvatarUrl(avatar);

              if (!dbUser) {
                dbUser = await prisma.user.create({
                  data: {
                    email,
                    name: safeName,
                    avatar: safeAvatar,
                  },
                });
              } else if (safeName || safeAvatar) {
                dbUser = await prisma.user.update({
                  where: { id: dbUser.id },
                  data: {
                    name: safeName || dbUser.name,
                    avatar: safeAvatar || dbUser.avatar,
                  },
                });
              }

              await clearRateLimit(email, "login_attempt_email");
              return { id: dbUser.id, email: dbUser.email, name: dbUser.name, image: dbUser.avatar };
            }

            if (authResult.status >= 500) {
              throw new Error(authResult.error || databaseUnavailableMessage("Supabase authentication"));
            }
          }

          // Legacy fallback: supports existing local password_hash users until migration is complete.
          const legacyUser = await prisma.user.findUnique({
            where: { email },
          });

          if (!legacyUser || !legacyUser.password_hash) return null;

          const [salt, hash] = legacyUser.password_hash.split(":");
          const verifyHash = crypto.scryptSync(password, salt, 64).toString("hex");

          if (hash !== verifyHash) return null;

          await clearRateLimit(email, "login_attempt_email");
          return {
            id: legacyUser.id,
            email: legacyUser.email,
            name: legacyUser.name,
            image: legacyUser.avatar,
          };
        } catch (error) {
          if (isPrismaDatabaseConnectivityError(error)) {
            throw new Error(databaseUnavailableMessage("Authentication"));
          }
          if (isPrismaSchemaMissingError(error)) {
            throw new Error(schemaMissingMessage("Authentication"));
          }
          throw error;
        }
      }
    })
  ],
  callbacks: {
    async signIn({ user, account, profile }: any) {
      if (!user.email || !isValidEmail(user.email)) return false;
      const normalizedEmail = normalizeEmail(user.email);

      try {
        // Check if user exists
        let dbUser = await prisma.user.findUnique({
          where: { email: normalizedEmail }
        });
        
        const socialName =
          sanitizeDisplayName(user.name) ||
          sanitizeDisplayName(profile?.name) ||
          sanitizeDisplayName(profile?.login) ||
          sanitizeDisplayName(profile?.preferred_username) ||
          null;
        const socialAvatar =
          sanitizeAvatarUrl(user.image) ||
          sanitizeAvatarUrl(profile?.picture) ||
          sanitizeAvatarUrl(profile?.avatar_url) ||
          null;

        const userId = dbUser?.id || crypto.randomUUID();

        if (!dbUser) {
          dbUser = await prisma.user.create({
            data: {
              id: userId,
              name: socialName,
              email: normalizedEmail,
              avatar: socialAvatar,
            }
          });
        } else if (account?.provider !== "credentials") {
          // Update profile details from social providers.
          dbUser = await prisma.user.update({
            where: { id: userId },
            data: {
              name: socialName || dbUser.name || null,
              avatar: socialAvatar || dbUser.avatar || null,
            }
          });
        }

        // If social login, link account identity only (no access token persistence by default).
        if (account && account.provider !== "credentials") {
          const existingAccount = await prisma.account.findUnique({
            where: {
              provider_providerAccountId: {
                provider: account.provider,
                providerAccountId: account.providerAccountId
              }
            }
          });

          if (!existingAccount) {
            await prisma.account.create({
              data: {
                userId: userId,
                type: account.type,
                provider: account.provider,
                providerAccountId: account.providerAccountId,
              }
            });
          }
        }

        user.id = dbUser.id;
        user.email = dbUser.email;
        user.name = dbUser.name || user.name;
        user.image = dbUser.avatar || user.image;

        return true;
      } catch (error) {
        console.error("NextAuth signIn callback failed:", error);
        if (isPrismaDatabaseConnectivityError(error)) {
          return "/login?error=database_unavailable";
        }
        if (isPrismaSchemaMissingError(error)) {
          return "/login?error=schema_missing";
        }
        return false;
      }
    },
    async jwt({ token, user, trigger, session }: any) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
      }
      if (trigger === "update" && session?.name) {
        token.name = session.name;
        // Optionally update other fields if needed
      }
      return token;
    },
    async session({ session, token }: any) {
      if (token && session.user) {
        session.user.id = token.id as string;
      }

      // Refresh user data from DB to get the latest
      if (session.user?.email) {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { email: normalizeEmail(session.user.email) }
          });
          if (dbUser) {
            session.user.id = dbUser.id;
            session.user.name = dbUser.name;
            session.user.image = dbUser.avatar;
            (session.user as any).dob = (dbUser as any).dob;
          }
        } catch (error) {
          console.error("Session callback DB lookup failed:", error);
        }
      }
      return session;
    },
    async redirect({ url, baseUrl }: { url: string; baseUrl: string }) {
      if (url.startsWith("/")) {
        return `${baseUrl}${url}`;
      }
      try {
        const parsedUrl = new URL(url);
        const parsedBase = new URL(baseUrl);
        if (parsedUrl.origin === parsedBase.origin) {
          return url;
        }
        if (
          parsedUrl.hostname.endsWith(".vercel.app") ||
          parsedUrl.hostname.includes("zyphor")
        ) {
          return url;
        }
      } catch {
        // Fall back to baseUrl
      }
      return baseUrl;
    },
  },
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  jwt: {
    maxAge: 7 * 24 * 60 * 60,
  },
  useSecureCookies: process.env.NODE_ENV === "production",
  pages: {
    signIn: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET as string
};

type DynamicServerUsageError = {
  digest?: string;
};

function isDynamicServerUsageError(error: unknown): error is DynamicServerUsageError {
  if (!error || typeof error !== "object") return false;
  return (error as DynamicServerUsageError).digest === "DYNAMIC_SERVER_USAGE";
}

export async function getUser() {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) return null;
    return session.user as any;
  } catch (error) {
    if (isDynamicServerUsageError(error)) {
      throw error;
    }
    console.error('Auth error:', error);
    return null;
  }
}
