// M1-10 slice 2: the other entry types, facts and questions in a real browser, against the real API and a scratch database.
// Runs after sync-library-bible.spec.ts (Mira Vale, Hollow Reach and the templates), studio.spec.ts (the owner account) and sync-editor.spec.ts (which makes the library and the book through
// sync, ids below), and before zz-lockout.spec.ts. Each browser context has its own storage and device id.
import { expect, request, test } from "@playwright/test";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.describe.configure({ mode: "serial" });

const PASSWORD = "correct horse battery staple";
const BASE = "http://127.0.0.1:15173";
const SHOTS = process.env.ROLLTOP_SHOT_DIR ?? "test-results/shots";
const DESKTOP = { width: 1280, height: 800 };
const U = (n: number): string => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LIB = U(1), BOOK = U(2);
const SCENE = U(10); // "Leave scene", made by sync-editor.spec.ts

async function apiLogin(): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: BASE });
  expect((await api.post("/api/auth/login", { data: { password: PASSWORD } })).ok()).toBeTruthy();
  return api;
}
async function epochOf(api: APIRequestContext): Promise<string> {
  const r = await api.get(`/api/sync/v1/changes?epoch=${randomUUID()}&after=0`);
  expect(r.status()).toBe(409);
  return (await r.json()).epoch;
}
async function feed(api: APIRequestContext): Promise<any[]> {
  const epoch = await epochOf(api);
  const out: any[] = [];
  let after = 0;
  for (;;) {
    const j = await (await api.get(`/api/sync/v1/changes?epoch=${epoch}&after=${after}&limit=1000`)).json();
    out.push(...j.changes);
    if (j.changes.length === 0 || j.next >= j.head) return out;
    after = j.next;
  }
}
async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}
async function newDevice(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 0; });
  const page = await ctx.newPage();
  await signIn(page);
  return { ctx, page };
}
const left = (page: Page) => page.getByRole("navigation", { name: "Book and sections" });

/** What the IndexedDB drafts store of this device holds. */
const drafts = (page: Page): Promise<any[]> => page.evaluate((dbName) => new Promise<any[]>((ok, no) => {
  const r = indexedDB.open(dbName);
  r.onerror = () => no(r.error);
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains("drafts")) { db.close(); ok([]); return; }
    const g = db.transaction("drafts").objectStore("drafts").getAll();
    g.onsuccess = () => { db.close(); ok(g.result); };
    g.onerror = () => no(g.error);
  };
}), `rolltop-library-${LIB}`);

/** A record of one kind as the server's feed holds it: the create value with later set and unset changes applied. */
async function recordOnServer(api: APIRequestContext, kind: string, text: string): Promise<any | undefined> {
  const changes = await feed(api);
  const made = changes.find((c) => c.recordKind === kind && c.change === "create" && (c.value.text === text || c.value.name === text));
  if (!made) return undefined;
  const rec = structuredClone(made.value);
  for (const c of changes) {
    if (c.recordKind !== kind || c.recordId !== made.recordId || (c.change !== "set" && c.change !== "unset")) continue;
    if (c.change === "set") rec[c.field] = c.value; else delete rec[c.field];
  }
  return rec;
}
const sectionOpen = async (page: Page) => {
  await left(page).getByRole("button", { name: "Worldbuilding", exact: true }).click();
  await expect(left(page).getByRole("heading", { name: "Worldbuilding", level: 2 })).toBeVisible();
};
const statusOf = (page: Page, label: string | RegExp, role: "textbox" | "combobox" | "group" = "textbox") =>
  (role === "group" ? page.getByRole("group", { name: label }) : page.getByLabel(label, { exact: true })).locator("xpath=ancestor::*[contains(@class,'field')][1]").getByRole("status");
const pushesOf = (page: Page): any[][] => {
  const out: any[][] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/sync/v1/push")) out.push(JSON.parse(r.postData() ?? "{}").ops ?? []); });
  return out;
};

let api: APIRequestContext;
test.beforeAll(async () => { api = await apiLogin(); });
test.afterAll(async () => { await api.dispose(); });

test("organizations, objects, plotlines, world rules and research notes are made in Worldbuilding with their own built-in templates", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  await sectionOpen(page);
  for (const h of ["Places", "Terms", "Organizations", "Objects", "Plotlines", "World rules", "Research notes", "Facts", "Questions"]) {
    await expect(left(page).getByRole("heading", { name: h, level: 3 })).toBeVisible();
  }
  await expect(left(page).getByRole("heading", { name: "Timeline", level: 3 })).toBeVisible(); // the timeline is slice 3
  const templates = (await feed(api)).filter((c) => c.recordKind === "template" && c.change === "create");
  const cases: Array<[string, string, string]> = [
    ["organization", "organization", "Lamp Guild"], ["object", "object", "Brass Key"], ["plotline", "plotline", "The Missing Ledger"],
    ["world rule", "worldRule", "No fire after dusk"], ["research note", "research", "Tide tables"],
  ];
  for (const [noun, type, name] of cases) {
    await left(page).getByRole("button", { name: `New ${noun}` }).click();
    await expect(page.getByRole("heading", { name: `New ${noun}` })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: `Create ${noun}` }).click();
    await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
    await expect(page.getByLabel("Given name")).toHaveCount(0);
    const rec = await recordOnServer(api, "entry", name);
    expect(rec).toMatchObject({ entryType: type, scope: { kind: "book", id: BOOK }, values: {} });
    expect(rec.templateId).toBe(templates.find((c) => c.value.entryType === type).recordId);
  }
  await expect(left(page).getByRole("list", { name: "Organizations" }).getByRole("button", { name: /Lamp Guild/ })).toBeVisible();
  await expect(left(page).getByRole("list", { name: "World rules" }).getByRole("button", { name: /No fire after dusk/ })).toContainText("World rule");
  await expect(left(page).getByRole("list", { name: "Research notes" }).getByRole("button", { name: /Tide tables/ })).toBeVisible();
  // Each template's own fields show, and a field saves.
  await left(page).getByRole("button", { name: /Lamp Guild/ }).click();
  await page.getByLabel("Summary", { exact: true }).fill("Keeps the lamps lit.");
  await page.getByLabel("Summary", { exact: true }).blur();
  await expect(statusOf(page, "Summary")).toHaveText("Saved");
  expect((await recordOnServer(api, "entry", "Lamp Guild")).summary).toBe("Keeps the lamps lit.");
  expect((await feed(api)).filter((c) => c.recordKind === "template" && c.change === "create")).toHaveLength(9);
  await page.screenshot({ path: `${SHOTS}/bible-worldbuilding-types-1280.png` });
  await ctx.close();
});

test("a fact: create, edit text, truth, entries, who knows it and scene; arrays are sent whole; a refused value is not sent", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  const pushes = pushesOf(page);
  await sectionOpen(page);
  await expect(left(page).getByText("No facts yet.")).toBeVisible();
  // An empty text is refused on the page, nothing is sent.
  await left(page).getByRole("button", { name: "New fact" }).click();
  await expect(page.getByRole("heading", { name: "New fact" })).toBeFocused();
  await page.getByRole("button", { name: "Create fact" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "text of the fact is needed" })).toBeVisible();
  expect(pushes.flat().filter((o) => o.recordKind === "fact")).toHaveLength(0);
  await page.getByLabel("Text", { exact: true }).fill("The bridge is closed after dark.");
  await page.getByRole("button", { name: "Create fact" }).click();
  await expect(page.getByRole("heading", { name: "The bridge is closed after dark.", level: 2 })).toBeVisible();
  let rec = await recordOnServer(api, "fact", "The bridge is closed after dark.");
  expect(rec).toMatchObject({ scope: { kind: "book", id: BOOK }, truth: "undecided", entryIds: [], knowledge: [] });
  expect(rec.orderKey).toMatch(/^[0-9a-z]+$/);
  expect(rec.orderKey.endsWith("0")).toBe(false);
  await expect(page.getByText(/belongs to the book "Test Book"/)).toBeVisible();
  await expect(left(page).getByRole("list", { name: "Facts" }).getByRole("button", { name: /bridge is closed/ })).toContainText("Not decided");

  // Text
  pushes.length = 0;
  await page.getByLabel("Text", { exact: true }).fill("The bridge is closed after dark, for everyone.");
  await page.getByLabel("Text", { exact: true }).blur();
  await expect(statusOf(page, "Text")).toHaveText("Saved");
  expect(pushes.flat()).toHaveLength(1);
  expect(pushes.flat()[0]).toMatchObject({ op: "set", recordKind: "fact", field: "text" });
  // Empty text is refused before it is sent
  pushes.length = 0;
  await page.getByLabel("Text", { exact: true }).fill("   ");
  await page.getByLabel("Text", { exact: true }).blur();
  await expect(page.getByRole("alert").filter({ hasText: "text of the fact is needed" })).toBeVisible();
  expect(pushes.flat()).toHaveLength(0);
  await page.getByLabel("Text", { exact: true }).fill("The bridge is closed after dark.");
  await page.getByLabel("Text", { exact: true }).blur();
  await expect(statusOf(page, "Text")).toHaveText("Saved");

  // Truth
  await page.getByLabel("Truth", { exact: true }).selectOption({ label: "False" });
  await expect(statusOf(page, "Truth")).toHaveText("Saved");
  // Entries it is about: the whole array each time
  pushes.length = 0;
  const about = page.getByRole("group", { name: "About these entries" });
  await about.getByLabel("Mira Vale (character)").check();
  await expect(about.getByRole("status")).toHaveText("Saved");
  await about.getByLabel("Hollow Reach (place)").check();
  await expect.poll(async () => (await recordOnServer(api, "fact", "The bridge is closed after dark.")).entryIds.length).toBe(2);
  const sets = pushes.flat().filter((o) => o.field === "entryIds");
  expect(sets).toHaveLength(2);
  expect(sets[0].value).toHaveLength(1);
  expect(sets[1].value).toHaveLength(2);
  expect(sets.every((o) => o.op === "set" && o.recordKind === "fact")).toBe(true);
  // Who knows it
  const know = page.getByRole("group", { name: "Who knows it" });
  await know.getByLabel("The reader").check();
  await know.getByLabel("Mira Vale").check();
  await expect.poll(async () => (await recordOnServer(api, "fact", "The bridge is closed after dark.")).knowledge).toEqual([{ knower: "reader" }, { knower: expect.any(String) }]);
  await expect(know.getByLabel("Hollow Reach")).toHaveCount(0); // only characters can know
  // Scene
  await page.getByLabel("Scene where it is established", { exact: true }).selectOption({ label: "Leave scene" });
  await expect(statusOf(page, "Scene where it is established")).toHaveText("Saved");
  rec = await recordOnServer(api, "fact", "The bridge is closed after dark.");
  expect(rec.nodeId).toBe(SCENE);
  expect(rec.truth).toBe("false");
  expect(rec.entryIds).toHaveLength(2);
  // Clearing the scene removes it; unchecking sends the whole smaller array
  await page.getByLabel("Scene where it is established", { exact: true }).selectOption({ label: "Not set" });
  await expect.poll(async () => (await recordOnServer(api, "fact", "The bridge is closed after dark.")).nodeId).toBeUndefined();
  await about.getByLabel("Hollow Reach (place)").uncheck();
  await expect.poll(async () => (await recordOnServer(api, "fact", "The bridge is closed after dark.")).entryIds.length).toBe(1);
  await know.getByLabel("Mira Vale").uncheck();
  await know.getByLabel("The reader").uncheck();
  await expect.poll(async () => (await recordOnServer(api, "fact", "The bridge is closed after dark.")).knowledge).toEqual([]);
  // After a reload everything comes back from the feed
  await page.reload();
  await sectionOpen(page);
  await left(page).getByRole("button", { name: /bridge is closed/ }).click();
  await expect(page.getByLabel("Truth", { exact: true })).toHaveValue("false");
  await expect(page.getByRole("group", { name: "About these entries" }).getByLabel("Mira Vale (character)")).toBeChecked();
  await expect(page.getByRole("group", { name: "About these entries" }).getByLabel("Hollow Reach (place)")).not.toBeChecked();
  expect((await drafts(page)).length).toBe(0);
  await ctx.close();
});

test("a question: create, edit text, topic, status, decision, entries and scene; the topic limit is checked on the page", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  const pushes = pushesOf(page);
  await sectionOpen(page);
  await left(page).getByRole("button", { name: "New question" }).click();
  await page.getByLabel("Text", { exact: true }).fill("Who sent the letter?");
  await page.getByRole("button", { name: "Create question" }).click();
  await expect(page.getByRole("heading", { name: "Who sent the letter?", level: 2 })).toBeVisible();
  let rec = await recordOnServer(api, "question", "Who sent the letter?");
  expect(rec).toMatchObject({ scope: { kind: "book", id: BOOK }, status: "open", entryIds: [] });
  expect(rec.topic).toBeUndefined();
  await expect(left(page).getByRole("list", { name: "Questions" }).getByRole("button", { name: /Who sent/ })).toContainText("Open");

  await page.getByLabel("Topic", { exact: true }).fill("The Overlord");
  await page.getByLabel("Topic", { exact: true }).blur();
  await expect(statusOf(page, "Topic")).toHaveText("Saved");
  await expect(left(page).getByRole("button", { name: /Who sent/ })).toContainText("The Overlord");
  // 65 characters are refused before they are sent
  pushes.length = 0;
  await page.getByLabel("Topic", { exact: true }).fill("t".repeat(65));
  await page.getByLabel("Topic", { exact: true }).blur();
  await expect(page.getByRole("alert").filter({ hasText: "topic can be at most 64 characters" })).toBeVisible();
  expect(pushes.flat()).toHaveLength(0);
  expect((await recordOnServer(api, "question", "Who sent the letter?")).topic).toBe("The Overlord");
  await page.getByLabel("Topic", { exact: true }).fill("t".repeat(64));
  await page.getByLabel("Topic", { exact: true }).blur();
  await expect(statusOf(page, "Topic")).toHaveText("Saved");
  // Clearing the topic removes it (an unset)
  pushes.length = 0;
  await page.getByLabel("Topic", { exact: true }).fill("");
  await page.getByLabel("Topic", { exact: true }).blur();
  await expect(statusOf(page, "Topic")).toHaveText("Saved");
  expect(pushes.flat()[0]).toMatchObject({ op: "unset", recordKind: "question", field: "topic" });
  expect((await recordOnServer(api, "question", "Who sent the letter?")).topic).toBeUndefined();

  await page.getByLabel("Decision", { exact: true }).fill("The archivist did.");
  await page.getByLabel("Decision", { exact: true }).blur();
  await expect(statusOf(page, "Decision")).toHaveText("Saved");
  await page.getByLabel("Status", { exact: true }).selectOption({ label: "Decided" });
  await expect(statusOf(page, "Status")).toHaveText("Saved");
  await page.getByRole("group", { name: "About these entries" }).getByLabel("Lamp Guild (organization)").check();
  await page.getByLabel("Scene to decide it by", { exact: true }).selectOption({ label: "Leave scene" });
  await expect(statusOf(page, "Scene to decide it by")).toHaveText("Saved");
  await page.getByLabel("Text", { exact: true }).fill("Who sent the first letter?");
  await page.getByLabel("Text", { exact: true }).blur();
  await expect(statusOf(page, "Text")).toHaveText("Saved");
  await expect.poll(async () => (await recordOnServer(api, "question", "Who sent the letter?"))?.decision).toBe("The archivist did.");
  rec = await recordOnServer(api, "question", "Who sent the letter?");
  expect(rec).toMatchObject({ status: "decided", nodeId: SCENE, text: "Who sent the first letter?" });
  expect(rec.entryIds).toHaveLength(1);
  await expect(left(page).getByRole("button", { name: /first letter/ })).toContainText("Decided");
  await ctx.close();
});

test("a fact or question in the trash shows as gone, and comes back when restored (as for entries)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 150; }); // a poll brings the trash change to the open page
  const page = await ctx.newPage();
  await signIn(page);
  await sectionOpen(page);
  const fact = (await feed(api)).find((c) => c.recordKind === "fact" && c.change === "create");
  await left(page).getByRole("button", { name: /bridge is closed/ }).click();
  const head = (await feed(api)).at(-1)!.seq;
  const tomb = await api.post("/api/sync/v1/push", { data: { epoch: await epochOf(api), deviceId: randomUUID(), ops: [{ opId: randomUUID(), op: "tombstone", recordKind: "fact", recordId: fact.recordId, baseSeq: head }] } });
  expect((await tomb.json()).results[0].status).toBe("applied");
  await expect(page.getByRole("heading", { name: "This fact is gone" })).toBeVisible();
  await page.reload();
  await sectionOpen(page);
  await expect(left(page).getByRole("button", { name: /bridge is closed/ })).toHaveCount(0);
  const res = await api.post("/api/sync/v1/push", { data: { epoch: await epochOf(api), deviceId: randomUUID(), ops: [{ opId: randomUUID(), op: "restore", recordKind: "fact", recordId: fact.recordId }] } });
  expect((await res.json()).results[0].status).toBe("applied");
  await page.reload();
  await sectionOpen(page);
  await expect(left(page).getByRole("button", { name: /bridge is closed/ })).toBeVisible();
  await ctx.close();
});

test("fact and question views are labelled, have 44 px targets, and fit a phone with Reduced Motion and Increase Contrast", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", contrast: "more" });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 0; });
  const page = await ctx.newPage();
  await signIn(page);
  await page.getByRole("button", { name: "Book and sections" }).click();
  await left(page).getByRole("button", { name: "Worldbuilding", exact: true }).click();
  for (const [name, list] of [[/bridge is closed/, "Facts"], [/first letter/, "Questions"]] as const) {
    if (!(await left(page).isVisible())) await page.getByRole("button", { name: "Book and sections" }).click();
    await left(page).getByRole("list", { name: list }).getByRole("button", { name }).click();
    await expect(page.getByRole("heading", { name, level: 2 })).toBeFocused();
    const result = await page.evaluate(() => {
      const nameOf = (el: Element): string => {
        const label = el.getAttribute("aria-label")?.trim();
        if (label) return label;
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.labels?.length) return [...el.labels].map((l) => l.textContent).join(" ").trim();
        return (el.textContent ?? "").trim();
      };
      const form = document.querySelector(".entry__form")!;
      const fields = [...form.querySelectorAll("input, textarea, select")];
      const small = [...form.querySelectorAll<HTMLElement>("input:not([type=checkbox]), textarea, select, button")].concat(
        [...form.querySelectorAll<HTMLElement>("input[type=checkbox]")].map((i) => i.closest(".check") as HTMLElement))
        .map((el) => { const r = el.getBoundingClientRect(); return { name: el.id || el.textContent?.trim(), w: r.width, h: r.height }; })
        .filter((t) => t.w < 43.99 || t.h < 43.99);
      return { count: fields.length, unnamed: fields.filter((el) => nameOf(el) === "").length, small, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
    });
    expect(result.count).toBeGreaterThan(4);
    expect(result.unnamed).toBe(0);
    expect(result.small).toEqual([]);
    expect(result.scrollW).toBeLessThanOrEqual(result.innerW);
    await page.screenshot({ path: `${SHOTS}/bible-${list.toLowerCase()}-390.png`, fullPage: true });
  }
  await ctx.close();
});
