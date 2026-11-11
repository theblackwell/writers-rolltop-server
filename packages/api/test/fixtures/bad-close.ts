// Test fixture: an app whose close() fails or hangs, with something keeping the event loop alive.
import { installShutdown } from "../../src/shutdown.ts";

const mode = process.env.CLOSE_MODE;
const app = { close: () => (mode === "hang" ? new Promise<never>(() => {}) : Promise.reject(new Error("close failed"))) };
installShutdown(app, { timeoutMs: 300 });
setInterval(() => {}, 1000);
console.log("ready");
