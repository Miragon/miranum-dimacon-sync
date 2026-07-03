import { defineConfig } from "@hey-api/openapi-ts"

export default defineConfig({
  input: "./open-api.json",
  output: { path: "./src/generated", module: { extension: ".js" } },
  plugins: [
    "@hey-api/typescript",
    "@hey-api/sdk",
    "@hey-api/client-fetch",
    {
      name: "zod",
      definitions: true,
      requests: true,
      responses: true,
    },
  ],
})
