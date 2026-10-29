import "dotenv/config";
import { defineConfig } from "prisma/config";

const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.STORAGE_DATABASE_URL ||
  process.env.STORAGE_PRISMA_DATABASE_URL ||
  process.env.STORAGE_POSTGRES_URL ||
  process.env.POSTGRES_URL ||
  "postgresql://postgres:postgres@localhost:5432/postgres";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: databaseUrl,
  },
});
