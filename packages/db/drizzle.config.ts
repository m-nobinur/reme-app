import { defineConfig } from "drizzle-kit"

// `drizzle-kit generate` never connects, so this file reads the environment
// directly rather than through `parseEnv`, which throws when DATABASE_URL is
// unset. Anything that does connect goes through `src/client.ts`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
})
