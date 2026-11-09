import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = "http://127.0.0.1:4141";
// Everything the Purser server answers that is not the web UI itself.
const proxied = [
  "/admin",
  "/auth",
  "/login",
  "/health",
  "/mcp",
  "/openai",
  "/anthropic",
  "/openrouter",
];

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    // Never inline assets as data: URIs. The server's Content Security Policy
    // allows only files served from Purser itself.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((path) => [path, server])),
  },
});
