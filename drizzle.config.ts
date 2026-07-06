import { defineConfig } from "drizzle-kit";
import "dotenv/config";

// Keep generated SQL migrations in-repo and drive target DB via DATABASE_URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "netlify/database/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
