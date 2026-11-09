import { buildApp } from "./app.ts";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";
const app = buildApp();
await app.listen({ port, host });
