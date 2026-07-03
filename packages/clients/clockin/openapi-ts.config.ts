import { defineConfig } from "@hey-api/openapi-ts"

export default defineConfig({
  input: "./openapi.yaml",
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
