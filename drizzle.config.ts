import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  // Migrationsordner liegt bewusst unter src/server: das Dockerfile kopiert
  // src/server komplett ins Runtime-Image, damit der Boot-Migrator die
  // SQL-Dateien findet — kein eigener COPY-Step nötig.
  out: "./src/server/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5400/miranum_sync",
  },
})
