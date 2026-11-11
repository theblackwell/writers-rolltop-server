import { defineConfig } from "@playwright/test";

const WEB_PORT = 15173;
const API_PORT = 18080;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One database and one owner account are shared, so the tests run one after another, in file order.
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    // The installed Google Chrome, so no browser download is needed.
    channel: "chrome",
  },
  webServer: {
    command: "npx vite",
    url: `http://127.0.0.1:${WEB_PORT}`,
    reuseExistingServer: false,
    env: { ROLLTOP_API_PORT: String(API_PORT), ROLLTOP_WEB_PORT: String(WEB_PORT) },
  },
});
