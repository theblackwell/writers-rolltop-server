// M1-10 slice 4: the Continuity list in Worldbuilding, in a real browser against the real API and a scratch database.
// Runs after sync-library-bible3.spec.ts and before zz-lockout.spec.ts. The test only looks at its own fact; other tests
// leave facts and questions behind that may or may not raise warnings of their own.
import { expect, request, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.describe.configure({ mode: "serial" });

const PASSWORD = "correct horse battery staple";
const BASE = "http://127.0.0.1:15173";
const DESKTOP = { width: 1280, height: 800 };
const U = (n: number): string => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BOOK = U(2);
const CHAPTER = U(400), EARLY = U(401), LATE = U(402), FACT = U(403);
const FACT_TEXT = "The lantern was lit before the flood";

async function apiLogin(): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: BASE });
  expect((await api.post("/api/auth/login", { data: { password: PASSWORD } })).ok()).toBeTruthy();
  return api;
}
async function epochAndHead(api: APIRequestContext): Promise<{ epoch: string; head: number }> {
  const r = await api.get(`/api/sync/v1/changes?epoch=${randomUUID()}&after=0`);
  expect(r.status()).toBe(409);
  const j = await r.json();
  return { epoch: j.epoch, head: j.head };
}
async function pushOps(api: APIRequestContext, ops: any[]): Promise<any[]> {
  const { epoch } = await epochAndHead(api);
  const res = await api.post("/api/sync/v1/push", { data: { epoch, deviceId: randomUUID(), ops } });
  return (await res.json()).results;
}
const now = (): string => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const create = (recordKind: string, value: Record<string, unknown>) => ({ opId: randomUUID(), op: "create", recordKind, recordId: value.id, value });
const left = (page: Page) => page.getByRole("navigation", { name: "Book and sections" });

let api: APIRequestContext;
test.beforeAll(async () => { api = await apiLogin(); });
test.afterAll(async () => { await api.dispose(); });

test("a fact learned before it is established shows a warning in plain words, opens, and clears when the scene order is fixed", async ({ browser }) => {
  const T = now();
  const results = await pushOps(api, [
    create("manuscriptNode", { id: CHAPTER, bookId: BOOK, kind: "chapter", title: "Continuity chapter", orderKey: "zz", createdAt: T, updatedAt: T }),
    create("manuscriptNode", { id: EARLY, bookId: BOOK, parentId: CHAPTER, kind: "scene", title: "The reading", orderKey: "m1", createdAt: T, updatedAt: T }),
    create("manuscriptNode", { id: LATE, bookId: BOOK, parentId: CHAPTER, kind: "scene", title: "The lighting", orderKey: "m2", createdAt: T, updatedAt: T }),
    create("fact", { id: FACT, scope: { kind: "book", id: BOOK }, text: FACT_TEXT, truth: "true", entryIds: [], nodeId: LATE, knowledge: [{ knower: "reader", nodeId: EARLY }], orderKey: "zzz", createdAt: T, updatedAt: T }),
  ]);
  expect(results.map((r) => r.status)).toEqual(["applied", "applied", "applied", "applied"]);

  // The server says the same, with ids only.
  const served = (await (await api.get("/api/continuity/warnings")).json()).warnings.filter((w: any) => w.recordId === FACT);
  expect(served).toHaveLength(1);
  expect(served[0]).toMatchObject({ kind: "learnedBeforeEstablished", recordKind: "fact", knower: "reader", learnNodeId: EARLY, factNodeId: LATE });

  const ctx = await browser.newContext({ viewport: DESKTOP });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 400; });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await left(page).getByRole("button", { name: "Worldbuilding", exact: true }).click();

  const section = left(page).getByRole("region", { name: "Continuity" });
  await expect(section.getByRole("heading", { name: "Continuity", level: 3 })).toBeVisible();
  const list = section.getByRole("list", { name: "Continuity warnings" });
  const item = list.getByRole("listitem").filter({ hasText: FACT_TEXT });
  await expect(item).toHaveCount(1);
  await expect(item.getByRole("heading", { level: 4 })).toHaveText("Check: Learned before it is established");
  await expect(item).toContainText(`The reader learns the fact "${FACT_TEXT}" in "The reading", which comes before "The lighting", where the fact is established.`);
  await expect(item).not.toContainText(U(401));
  // No dismiss, undo or "checked" controls in this slice.
  await expect(item.getByRole("button")).toHaveCount(1);

  const open = item.getByRole("button", { name: "Open the fact" });
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await open.click();
  await expect(page.getByRole("heading", { name: FACT_TEXT, level: 2 })).toBeFocused();

  // Fix it from another device: the reading scene now comes after the lighting scene.
  const { head } = await epochAndHead(api);
  const [fixed] = await pushOps(api, [{ opId: randomUUID(), op: "set", recordKind: "manuscriptNode", recordId: EARLY, field: "orderKey", value: "m3", baseSeq: head }]);
  expect(fixed.status).toBe("applied");
  await expect(list.getByRole("listitem").filter({ hasText: FACT_TEXT })).toHaveCount(0);
  expect((await (await api.get("/api/continuity/warnings")).json()).warnings.filter((w: any) => w.recordId === FACT)).toEqual([]);
  await ctx.close();
});

test("a failed request shows an error with a way to try again, and the empty state is in plain words", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 0; });
  const page = await ctx.newPage();
  let fail = true;
  await page.route("**/api/continuity/warnings", (route) => (fail ? route.fulfill({ status: 500, body: "{}" }) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ warnings: [] }) })));
  await page.goto("/");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await left(page).getByRole("button", { name: "Worldbuilding", exact: true }).click();
  const section = left(page).getByRole("region", { name: "Continuity" });
  await expect(section.getByRole("alert")).toContainText("Could not get the warnings");
  fail = false;
  await section.getByRole("button", { name: "Try again" }).click();
  await expect(section.getByText(/^Nothing to check/)).toBeVisible();
  await ctx.close();
});
