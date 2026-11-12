// M1-10 slice 1: characters, places and terms in a real browser, against the real API and a scratch database.
// Runs after studio.spec.ts (the owner account) and sync-editor.spec.ts (which makes the library and the book through
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
const AGE = "90000003-0000-4000-8000-000000000003";
const SUMMARY_FIELD = "summary";

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
/** The entry as the server's feed holds it: the create value with later set and unset changes applied. */
async function entryOnServer(api: APIRequestContext, name: string): Promise<any | undefined> {
  const changes = await feed(api);
  const made = changes.find((c) => c.recordKind === "entry" && c.change === "create" && c.value.name === name);
  if (!made) return undefined;
  const rec = structuredClone(made.value);
  for (const c of changes) {
    if (c.recordKind !== "entry" || c.recordId !== made.recordId || (c.change !== "set" && c.change !== "unset")) continue;
    const path = c.field.split("/");
    let at = rec;
    for (const p of path.slice(0, -1)) at = at[p] ??= {};
    if (c.change === "set") at[path.at(-1)] = c.value; else delete at[path.at(-1)];
  }
  return rec;
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
async function openSection(page: Page, name: "Characters" | "Worldbuilding") {
  await left(page).getByRole("button", { name, exact: true }).click();
  await expect(left(page).getByRole("heading", { name, level: 2 })).toBeVisible();
}
async function createEntry(page: Page, kind: "character" | "place" | "term", name: string) {
  await left(page).getByRole("button", { name: `New ${kind}` }).click();
  await expect(page.getByRole("heading", { name: `New ${kind}` })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: `Create ${kind}` }).click();
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
}
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

let api: APIRequestContext;
test.beforeAll(async () => { api = await apiLogin(); });
test.afterAll(async () => { await api.dispose(); });

test("opening the story bible makes the built-in templates once; a character is created and is in Characters after a reload, through the feed", async ({ browser }) => {
  const before = (await feed(api)).filter((c) => c.recordKind === "template");
  expect(before).toHaveLength(0); // a new library made through sync has no templates, and opening the studio does not make them
  const { ctx, page } = await newDevice(browser);
  expect(await page.evaluate(() => localStorage.getItem("rolltop.deviceId"))).toBeNull(); // viewing the manuscript sent nothing
  await openSection(page, "Characters");
  await expect(left(page).getByRole("button", { name: "New character" })).toBeVisible();
  await expect(left(page).getByText("No characters yet.")).toBeVisible();
  const templates = (await feed(api)).filter((c) => c.recordKind === "template" && c.change === "create");
  expect(templates).toHaveLength(9);
  expect(templates.every((c) => c.value.builtIn === true)).toBe(true);
  expect(templates.find((c) => c.value.entryType === "character").recordId).toBe("80000001-0000-4000-8000-000000000001");
  expect((await feed(api)).filter((c) => c.recordKind === "field" && c.change === "create")).toHaveLength(14);

  await createEntry(page, "character", "Mira Vale");
  const rec = await entryOnServer(api, "Mira Vale");
  expect(rec).toMatchObject({ entryType: "character", templateId: "80000001-0000-4000-8000-000000000001", scope: { kind: "book", id: BOOK }, values: {}, aliases: [], overrides: [], attachments: [] });
  expect(rec.createdAt).toBe(rec.updatedAt);
  expect(rec.toBeNamed).toBeUndefined();
  // The scope is said in plain words.
  await expect(page.getByText(/shared by every book in that scope/)).toBeVisible();
  await expect(page.getByText(/belongs to the book "Test Book"/)).toBeVisible();

  // A reload: the character comes back from the change feed, and the templates are not made again.
  await page.reload();
  await openSection(page, "Characters");
  const item = left(page).getByRole("list", { name: "Characters" }).getByRole("button", { name: /Mira Vale/ });
  await expect(item).toBeVisible();
  await expect(item).toContainText("Character");
  expect((await feed(api)).filter((c) => c.recordKind === "template" && c.change === "create")).toHaveLength(9);
  await page.screenshot({ path: `${SHOTS}/bible-characters-1280.png` });
  await ctx.close();
});

test("editing the summary: nothing is sent while typing, leaving the field saves, Saving shows until the server answers, then Saved", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  const pushes: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await openSection(page, "Characters");
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  await expect(page.getByRole("heading", { name: "Mira Vale", level: 2 })).toBeVisible();
  await page.route("**/api/sync/v1/push", async (route) => { pushes.push(JSON.parse(route.request().postData() ?? "{}")); await gate; await route.continue(); });
  const summary = page.getByLabel("Summary", { exact: true });
  await summary.fill("Reads letters twice.");
  await page.waitForTimeout(500);
  expect(pushes).toHaveLength(0);
  await summary.blur();
  const field = page.locator(".field", { has: summary });
  await expect(field.getByRole("status")).toHaveText("Saving");
  expect(pushes).toHaveLength(1);
  expect(pushes[0].ops).toHaveLength(1);
  expect(pushes[0].ops[0]).toMatchObject({ op: "set", recordKind: "entry", field: SUMMARY_FIELD, value: "Reads letters twice." });
  expect(typeof pushes[0].ops[0].baseSeq).toBe("number");
  expect((await entryOnServer(api, "Mira Vale")).summary).toBeUndefined(); // the server has not answered
  expect(await field.getByRole("status").innerText()).not.toBe("Saved");
  release();
  await expect(field.getByRole("status")).toHaveText("Saved");
  expect((await entryOnServer(api, "Mira Vale")).summary).toBe("Reads letters twice.");
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
  // The list shows the short summary.
  await expect(left(page).getByRole("button", { name: /Mira Vale/ })).toContainText("Reads letters twice.");
  // Given and family names exist on characters; the type line and the template fields are there.
  await expect(page.getByLabel("Given name", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Family name", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Role", { exact: true })).toBeVisible();
  await page.getByLabel("Role", { exact: true }).fill("Protagonist");
  await page.getByLabel("Given name", { exact: true }).fill("Mira");
  await page.getByLabel("Family name", { exact: true }).fill("Vale");
  await page.getByLabel("Aliases").fill("The Archivist's Daughter\nM.");
  await page.getByLabel("Aliases").blur();
  await expect(page.locator(".field", { has: page.getByLabel("Aliases") }).getByRole("status")).toHaveText("Saved");
  await expect.poll(async () => (await entryOnServer(api, "Mira Vale")).familyName).toBe("Vale");
  const rec = await entryOnServer(api, "Mira Vale");
  expect(rec.givenName).toBe("Mira");
  expect(rec.aliases).toEqual(["The Archivist's Daughter", "M."]);
  expect(Object.values(rec.values)).toEqual(["Protagonist"]);
  await ctx.close();
});

test("a value of the wrong type is refused on the page before it is sent; the text stays", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  const pushes: unknown[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/sync/v1/push")) pushes.push(r.postData()); });
  await openSection(page, "Characters");
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  const age = page.getByLabel("Age", { exact: true });
  await age.fill("twenty four");
  await age.blur();
  await expect(page.getByRole("alert").filter({ hasText: "Enter a whole number" })).toBeVisible();
  await expect(age).toHaveValue("twenty four");
  expect(pushes).toHaveLength(0);
  expect((await entryOnServer(api, "Mira Vale")).values[AGE]).toBeUndefined();
  expect((await drafts(page)).map((d) => d.input)).toContain("twenty four");
  await age.fill("24.5");
  await age.blur();
  await expect(page.getByRole("alert").filter({ hasText: "Enter a whole number" })).toBeVisible();
  await age.fill("24");
  await age.blur();
  await expect(page.locator(".field", { has: age }).getByRole("status")).toHaveText("Saved");
  expect((await entryOnServer(api, "Mira Vale")).values[AGE]).toBe(24);
  expect(typeof (await entryOnServer(api, "Mira Vale")).values[AGE]).toBe("number");
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
  await ctx.close();
});

test("a value the server rejects (INVALID_VALUE) shows the server's plain message and keeps the text on the page and on the device", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  await openSection(page, "Characters");
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  // The page's own check lets this value through; the server is made to refuse it, with the message the real server gives.
  await page.route("**/api/sync/v1/push", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const epoch = body.epoch;
    await route.fulfill({ json: { epoch, head: 1, results: body.ops.map((o: any) => ({ opId: o.opId, status: "rejected", code: "INVALID_VALUE", message: "The value does not fit the record." })) } });
  });
  const biography = page.getByLabel("Biography", { exact: true });
  await biography.fill("Grew up above the archive.");
  await biography.blur();
  const alert = page.getByRole("alert").filter({ hasText: "The value does not fit the record." });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("kept on this device");
  await expect(biography).toHaveValue("Grew up above the archive.");
  const kept = await drafts(page);
  expect(kept.map((d) => d.input)).toEqual(["Grew up above the archive."]);
  expect(kept[0].state).toBe("refused");
  const mira = await entryOnServer(api, "Mira Vale");
  expect(Object.keys(mira.values)).not.toContain("90000002-0000-4000-8000-000000000002");
  // After a reload the text comes back from the device; once the server takes it, the copy goes.
  await page.unroute("**/api/sync/v1/push");
  await page.reload();
  await openSection(page, "Characters");
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  await expect(page.getByLabel("Biography", { exact: true })).toHaveValue("Grew up above the archive.");
  await expect(page.getByRole("alert").filter({ hasText: "Not saved yet" })).toBeVisible();
  await page.getByRole("button", { name: "Save now" }).click();
  await expect(page.locator(".field", { has: page.getByLabel("Biography", { exact: true }) }).getByRole("status")).toHaveText("Saved");
  expect((await entryOnServer(api, "Mira Vale")).values["90000002-0000-4000-8000-000000000002"]).toBe("Grew up above the archive.");
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
  await ctx.close();
});

test("a place and a term can be created in Worldbuilding, and each has its own id and its template's fields", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  await openSection(page, "Worldbuilding");
  await expect(left(page).getByRole("heading", { name: "Places", level: 3 })).toBeVisible();
  await expect(left(page).getByRole("heading", { name: "Terms", level: 3 })).toBeVisible();
  await createEntry(page, "place", "Hollow Reach");
  await expect(page.getByLabel("Climate", { exact: true })).toBeVisible();
  await page.getByLabel("Climate", { exact: true }).selectOption({ label: "Maritime" });
  await expect(page.locator(".field", { has: page.getByLabel("Climate", { exact: true }) }).getByRole("status")).toHaveText("Saved");
  await createEntry(page, "term", "Lumen");
  await page.getByLabel("Meaning", { exact: true }).fill("Light remembered.");
  await page.getByLabel("Meaning", { exact: true }).blur();
  await expect(page.locator(".field", { has: page.getByLabel("Meaning", { exact: true }) }).getByRole("status")).toHaveText("Saved");
  await page.getByLabel("Summary", { exact: true }).fill("A word for remembered light.");
  await page.getByLabel("Summary", { exact: true }).blur();
  await expect(page.locator(".field", { has: page.getByLabel("Summary", { exact: true }) }).getByRole("status")).toHaveText("Saved");
  await expect(page.getByLabel("Given name")).toHaveCount(0); // given and family names are for characters only
  const place = await entryOnServer(api, "Hollow Reach");
  const term = await entryOnServer(api, "Lumen");
  expect(place).toMatchObject({ entryType: "location", templateId: "80000002-0000-4000-8000-000000000002", scope: { kind: "book", id: BOOK } });
  expect(term).toMatchObject({ entryType: "term", templateId: "80000009-0000-4000-8000-000000000009" });
  expect(place.values["9000000c-0000-4000-8000-00000000000c"]).toEqual(["a00004b1-0000-4000-8000-0000000004b1"]);
  expect(term.values["90000019-0000-4000-8000-000000000019"]).toBe("Light remembered.");
  // A second entry never reuses an id.
  await createEntry(page, "term", "Corvane");
  const ids = (await feed(api)).filter((c) => c.recordKind === "entry" && c.change === "create").map((c) => c.recordId);
  expect(ids).toHaveLength(4); // Mira Vale, Hollow Reach, Lumen, Corvane and none other
  expect(new Set(ids).size).toBe(ids.length);
  expect((await feed(api)).filter((c) => c.recordKind === "template" && c.change === "create")).toHaveLength(9);
  // The lists.
  await expect(left(page).getByRole("list", { name: "Places" }).getByRole("button", { name: /Hollow Reach/ })).toBeVisible();
  const terms = left(page).getByRole("list", { name: "Terms" });
  await expect(terms.getByRole("button", { name: /Lumen/ })).toContainText("A word for remembered light.");
  await expect(terms.getByRole("button", { name: /Corvane/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/bible-worldbuilding-1280.png` });
  await ctx.close();
});

test("the entry view is labelled, in heading order, keyboard-reachable, with 44 px targets; the sample notice stays for the placeholders", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  await openSection(page, "Characters");
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  await expect(page.getByRole("heading", { name: "Mira Vale", level: 2 })).toBeFocused();
  const result = await page.evaluate(() => {
    const nameOf = (el: Element): string => {
      const label = el.getAttribute("aria-label")?.trim();
      if (label) return label;
      const by = el.getAttribute("aria-labelledby");
      if (by) return by.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.labels?.length) return [...el.labels].map((l) => l.textContent).join(" ").trim();
      return (el.textContent ?? "").trim();
    };
    const form = document.querySelector(".entry__form")!;
    const fields = [...form.querySelectorAll("input, textarea, select")];
    const unnamed = fields.filter((el) => nameOf(el) === "").map((el) => el.outerHTML.slice(0, 80));
    const small = [...form.querySelectorAll<HTMLElement>("input:not([type=checkbox]), textarea, select, button")].concat(
      [...form.querySelectorAll<HTMLElement>("input[type=checkbox]")].map((i) => i.closest(".check") as HTMLElement))
      .map((el) => { const r = el.getBoundingClientRect(); return { name: el.id || el.textContent?.trim(), w: r.width, h: r.height }; })
      .filter((t) => t.w < 43.99 || t.h < 43.99);
    const levels = [...document.querySelectorAll("h1,h2,h3")].map((h) => Number(h.tagName[1]));
    return { count: fields.length, unnamed, small, levels, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
  });
  expect(result.count).toBeGreaterThan(10);
  expect(result.unnamed).toEqual([]);
  expect(result.small).toEqual([]);
  expect(result.levels.filter((l) => l === 1)).toHaveLength(1);
  result.levels.forEach((l, i) => { if (i > 0) expect(l - result.levels[i - 1]!).toBeLessThanOrEqual(1); });
  expect(result.scrollW).toBeLessThanOrEqual(result.innerW);
  // The read-only kinds are shown as such.
  await expect(page.getByText("Portrait")).toBeVisible();
  await expect(page.getByText("Shown here only").first()).toBeVisible();
  // Keyboard: Tab moves from a field to the next one; Enter in a text field does not submit anything or reload.
  await page.getByLabel("Summary", { exact: true }).focus();
  // The element after Summary in the page's own order of focusable elements.
  const nextId = await page.evaluate(() => {
    const form = document.querySelector(".entry__form")!;
    const focusable = [...form.querySelectorAll<HTMLElement>("input, textarea, select, button, a[href], [tabindex]:not([tabindex='-1'])")]
      .filter((el) => !(el as HTMLInputElement).disabled && el.getClientRects().length > 0);
    const at = focusable.findIndex((el) => el === document.activeElement);
    const next = focusable[at + 1];
    if (at < 0 || !next) return null;
    next.setAttribute("data-expected-next", "yes");
    return next.id || next.tagName;
  });
  expect(nextId).not.toBeNull();
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-expected-next]")).toBeFocused();
  await expect(page.getByLabel("Aliases")).not.toBeFocused();
  // The sample notice stays: Quick Notes and the Book Bible links are still placeholders.
  const notice = page.getByRole("region", { name: "Sample content notice" });
  await expect(notice).toContainText("Sample content");
  await expect(notice).toContainText("not connected");
  await expect(page.getByRole("heading", { name: "Quick Notes (sample)" })).toBeVisible();
  // Sections that are still placeholders say so.
  await left(page).getByRole("button", { name: "Revisions", exact: true }).click();
  await expect(left(page).getByText("Revisions is not connected to your library yet.")).toBeVisible();
  await ctx.close();
});

test("a refused create is retried with a new op id; a create whose answer was lost keeps its op id", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  const creates: any[] = [];
  let mode: "refuse" | "lose" | "pass" = "refuse";
  await page.route("**/api/sync/v1/push", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const op = body.ops.find((o: any) => o.op === "create" && o.recordKind === "entry");
    if (!op) return route.continue();
    creates.push(op);
    if (mode === "refuse") { mode = "pass"; return route.fulfill({ json: { epoch: body.epoch, head: 1, results: body.ops.map((o: any) => ({ opId: o.opId, status: "rejected", code: "INVALID_VALUE", message: "The value does not fit the record." })) } }); }
    if (mode === "lose") { mode = "pass"; return route.abort("failed"); }
    return route.continue();
  });
  await openSection(page, "Worldbuilding");
  await left(page).getByRole("button", { name: "New term" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Refused Term");
  await page.getByRole("button", { name: "Create term" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The value does not fit the record." })).toBeVisible();
  await page.getByRole("button", { name: "Create term" }).click();
  await expect(page.getByRole("heading", { name: "Refused Term", level: 2 })).toBeVisible();
  expect(creates).toHaveLength(2);
  expect(creates[1].opId).not.toBe(creates[0].opId);
  expect(creates[1].recordId).not.toBe(creates[0].recordId);

  creates.length = 0; mode = "lose";
  await left(page).getByRole("button", { name: "New term" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Lost Answer Term");
  await page.getByRole("button", { name: "Create term" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not reach the server" })).toBeVisible();
  await page.getByRole("button", { name: "Create term" }).click();
  await expect(page.getByRole("heading", { name: "Lost Answer Term", level: 2 })).toBeVisible();
  expect(creates).toHaveLength(2);
  expect(creates[1].opId).toBe(creates[0].opId);
  expect(creates[1].recordId).toBe(creates[0].recordId);
  await ctx.close();
});

test("an epoch change keeps text typed in a bible field that was not left: it is on the device and the page says so; nothing is sent", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 150; });
  const page = await ctx.newPage();
  await signIn(page);
  const newEpoch = randomUUID();
  const realEpoch = await epochOf(api);
  let fake = false;
  const pushes: unknown[] = [];
  await page.route("**/api/sync/v1/changes*", async (route) => {
    if (!fake) return route.continue();
    const url = new URL(route.request().url());
    if (url.searchParams.get("epoch") !== newEpoch) return route.fulfill({ status: 409, json: { error: { code: "RESYNC_REQUIRED", message: "x" }, epoch: newEpoch, head: 0 } });
    url.searchParams.set("epoch", realEpoch);
    const real = await (await route.fetch({ url: url.toString() })).json();
    return route.fulfill({ json: { ...real, epoch: newEpoch } });
  });
  await page.route("**/api/sync/v1/conflicts*", (route) => (fake ? route.fulfill({ json: { conflicts: [] } }) : route.continue()));
  await page.route("**/api/sync/v1/push", async (route) => { pushes.push(route.request().postData()); await route.continue(); });
  await openSection(page, "Characters");
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  const summary = page.getByLabel("Summary", { exact: true });
  await summary.fill("Typed just before the history changed.");
  fake = true; // the next poll sees a different history; the field was never left
  await expect.poll(async () => (await drafts(page)).map((d) => d.input)).toContain("Typed just before the history changed.");
  const kept = (await drafts(page)).find((d) => d.input === "Typed just before the history changed.");
  expect(kept.state).toBe("conflict");
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("Typed just before the history changed.");
  await expect(page.getByRole("alert").filter({ hasText: "kept on this device" })).toBeVisible();
  await page.waitForTimeout(600);
  expect(pushes).toHaveLength(0);
  await ctx.close();
});

test("after an epoch change, leaving the field with the old text does not push it; the author sees the choice", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 150; });
  const page = await ctx.newPage();
  await signIn(page);
  const newEpoch = randomUUID();
  const realEpoch = await epochOf(api);
  let fake = false;
  const pushes: unknown[] = [];
  await page.route("**/api/sync/v1/changes*", async (route) => {
    if (!fake) return route.continue();
    const url = new URL(route.request().url());
    if (url.searchParams.get("epoch") !== newEpoch) return route.fulfill({ status: 409, json: { error: { code: "RESYNC_REQUIRED", message: "x" }, epoch: newEpoch, head: 0 } });
    url.searchParams.set("epoch", realEpoch);
    const real = await (await route.fetch({ url: url.toString() })).json();
    return route.fulfill({ json: { ...real, epoch: newEpoch } });
  });
  await page.route("**/api/sync/v1/conflicts*", (route) => (fake ? route.fulfill({ json: { conflicts: [] } }) : route.continue()));
  await page.route("**/api/sync/v1/push", async (route) => { pushes.push(route.request().postData()); await route.continue(); });
  await openSection(page, "Characters");
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  const summary = page.getByLabel("Summary", { exact: true });
  await summary.fill("Old-history text, then leaving the field.");
  fake = true;
  await expect(page.getByRole("alert").filter({ hasText: "kept on this device" })).toBeVisible();
  await summary.focus();
  await page.getByLabel("Name", { exact: true }).focus(); // the blur of the summary
  await page.waitForTimeout(600);
  expect(pushes).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Keep my text" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Use the saved text" }).first()).toBeVisible();
  await ctx.close();
});

test("on a phone the list opens behind its button, the entry opens in the centre, and nothing scrolls sideways", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 0; });
  const page = await ctx.newPage();
  await signIn(page);
  await page.getByRole("button", { name: "Book and sections" }).click();
  await left(page).getByRole("button", { name: "Characters", exact: true }).click();
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  await expect(page.getByRole("heading", { name: "Mira Vale", level: 2 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/bible-entry-390.png`, fullPage: true });
  await ctx.close();
});
