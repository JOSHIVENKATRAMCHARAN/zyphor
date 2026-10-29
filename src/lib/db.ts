import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import fs from "fs";
import path from "path";

const DB_ENV_KEYS = [
  "DATABASE_URL",
  "STORAGE_DATABASE_URL_POOLED",
  "STORAGE_DATABASE_URL",
  "STORAGE_PRISMA_DATABASE_URL",
  "STORAGE_POSTGRES_URL",
  "POSTGRES_URL",
];

function readDatabaseUrlFromDotEnv(): string | null {
  if (process.env.NODE_ENV === "production") return null;

  try {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return null;

    const envContent = fs.readFileSync(envPath, "utf8");
    const parsed: Record<string, string> = {};
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;

      const key = trimmed.slice(0, idx).trim();
      const rawValue = trimmed.slice(idx + 1).trim();
      parsed[key] = rawValue.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
    }

    for (const key of DB_ENV_KEYS) {
      if (parsed[key]) return parsed[key];
    }
  } catch {
    // Ignore and fall back to process env
  }

  return null;
}

function getSafeTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function getConnectionString(): string {
  let envValue = "";
  for (const key of DB_ENV_KEYS) {
    if (process.env[key]?.trim()) {
      envValue = process.env[key]!.trim();
      break;
    }
  }

  const dotEnvValue = readDatabaseUrlFromDotEnv() || "";
  const value = dotEnvValue || envValue;

  if (!value) {
    throw new Error("DATABASE_URL is not set.");
  }

  if (dotEnvValue && envValue && dotEnvValue !== envValue) {
    console.warn(
      `[db] DATABASE_URL mismatch detected. Using .env target=${getSafeTarget(dotEnvValue)} instead of process env target=${getSafeTarget(envValue)}.`
    );
  }

  if (value.includes("db.your-project-ref.supabase.co")) {
    throw new Error("DATABASE_URL is still a placeholder. Replace it with your real Supabase or Prisma Postgres connection string.");
  }

  return value;
}

function shouldDisableTlsVerification(connectionString: string): boolean {
  const explicitSetting = process.env.DATABASE_SSL_NO_VERIFY?.trim().toLowerCase();
  if (explicitSetting === "true") return true;
  if (explicitSetting === "false") return false;

  try {
    const sslMode = new URL(connectionString).searchParams.get("sslmode")?.toLowerCase();
    return sslMode === "no-verify";
  } catch {
    return false;
  }
}

function normalizeConnectionStringForPg(
  connectionString: string,
  disableTlsVerification: boolean
): string {
  try {
    const url = new URL(connectionString);

    // When ssl config is passed explicitly to pg, keep SSL query params out of URL
    // to avoid pg overriding config values from connection string.
    url.searchParams.delete("sslmode");
    url.searchParams.delete("sslrootcert");
    url.searchParams.delete("sslcert");
    url.searchParams.delete("sslkey");

    if (!disableTlsVerification) {
      url.searchParams.set("sslmode", "require");
    }

    return url.toString();
  } catch {
    return connectionString;
  }
}

function createPrismaClient() {
  const connectionString = getConnectionString();
  const disableTlsVerification = shouldDisableTlsVerification(connectionString);
  const normalizedConnectionString = normalizeConnectionStringForPg(
    connectionString,
    disableTlsVerification
  );

  const adapter = new PrismaPg({
    connectionString: normalizedConnectionString,
    ...(disableTlsVerification ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  if (disableTlsVerification) {
    console.warn("[db] TLS certificate verification is disabled for Prisma (DATABASE_SSL_NO_VERIFY=true or sslmode=no-verify).");
  }

  if (process.env.PRISMA_LOG_QUERIES === "true") {
    return new PrismaClient({ adapter, log: ["query", "error", "warn"] });
  }
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaHostLogged: boolean | undefined;
};

let cachedPrisma: PrismaClient | undefined = globalForPrisma.prisma;

export function getPrismaClient(): PrismaClient {
  if (cachedPrisma) {
    return cachedPrisma;
  }
  if (globalForPrisma.prisma) {
    cachedPrisma = globalForPrisma.prisma;
    return cachedPrisma;
  }

  cachedPrisma = createPrismaClient();
  globalForPrisma.prisma = cachedPrisma;

  if (process.env.NODE_ENV !== "production" && !globalForPrisma.prismaHostLogged) {
    const dotEnvValue = readDatabaseUrlFromDotEnv() || "";
    const envValue = process.env.DATABASE_URL?.trim() || "";
    const chosen = dotEnvValue || envValue;
    console.warn(`[db] Active Prisma target=${getSafeTarget(chosen)} source=${dotEnvValue ? ".env" : "process.env"}`);
    globalForPrisma.prismaHostLogged = true;
  }

  return cachedPrisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (prop === "then" || prop === "$$typeof") {
      return undefined;
    }
    const client = getPrismaClient();
    const value = Reflect.get(client, prop, receiver);
    if (typeof value === "function") {
      return value.bind(client);
    }
    return value;
  },
});

