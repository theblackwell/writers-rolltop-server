import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The studio calls the API at /api. In dev and preview, Vite forwards /api to the API process, so the browser sees one
// origin and the session cookie works. The API port is ROLLTOP_API_PORT, then PORT (as the API reads it), then 8080.
const apiPort = process.env.ROLLTOP_API_PORT ?? process.env.PORT ?? "8080";
const proxy = { "/api": { target: `http://127.0.0.1:${apiPort}` } };
const webPort = process.env.ROLLTOP_WEB_PORT ? Number(process.env.ROLLTOP_WEB_PORT) : undefined;

export default defineConfig({
  plugins: [react()],
  server: { proxy, host: "127.0.0.1", ...(webPort ? { port: webPort, strictPort: true } : {}) },
  preview: { proxy, host: "127.0.0.1", ...(webPort ? { port: webPort, strictPort: true } : {}) },
});
