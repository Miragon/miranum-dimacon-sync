import path from "node:path"
import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig({
  root: "src/client",
  envDir: import.meta.dirname,
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "#": path.resolve(import.meta.dirname, "./src/client"),
      "@": path.resolve(import.meta.dirname, "./src/client"),
    },
  },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: path.resolve(import.meta.dirname, "src/client/routes"),
      generatedRouteTree: path.resolve(import.meta.dirname, "src/client/routeTree.gen.ts"),
    }),
    viteReact(),
  ],
  server: {
    port: 3000,
    proxy: {
      "/api": "http://localhost:3020",
    },
  },
})

export default config
