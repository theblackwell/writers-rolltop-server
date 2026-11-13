// M1-9: the editor and the sync client in a real browser, against the real API and a scratch database.
// Runs after studio.spec.ts (which creates the owner account) and before zz-lockout.spec.ts. The library here is made
// through sync, so its change feed is complete. Every browser context has its own storage, hence its own device id.
import { expect, request, test } from "@playwright/test";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test.describe.configure({ mode: "serial" });

const PASSWORD = "correct horse battery staple";
const BASE = "http://127.0.0.1:15173";
const SHOTS = process.env.ROLLTOP_SHOT_DIR ?? "test-results/shots";
const DESKTOP = { width: 1280, height: 800 };
const fixtureDir = fileURLToPath(new URL("../../document-adapter/test/spec/fixtures/documents/valid/", import.meta.url));
const fixture = (name: string): any => JSON.parse(readFileSync(`${fixtureDir}${name}.json`, "utf8"));

const U = (n: number): string => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LIB = U(1), BOOK = U(2), CHAPTER = U(3);
const T = "2026-11-01T09:00:00Z";

// Scenes: id, title, first text.
const SCENES = {
  leave: [U(10), "Leave scene", "Leave text"],
  fail: [U(11), "Failing scene", "Fail text"],
  both: [U(12), "Both scene", "Shared start"],
  mine: [U(13), "Mine scene", "Shared start"],
  saved: [U(14), "Saved scene", "Shared start"],
  tools: [U(15), "Tools scene", "Plain words here"],
  refused: [U(16), "Refused scene", "Refused text"],
  epoch: [U(17), "Epoch scene", "Epoch text"],
  one: [U(18), "Switch one", "One text"],
  two: [U(19), "Switch two", "Two text"],
  out: [U(20), "Closing scene", "Out text"],
  fm: [U(21), "Front matter", "Shared start"],
  cboth: [U(22), "Copy both", "Shared start"],
  crefuse: [U(23), "Copy refused", "Shared start"],
  typed: [U(24), "Typed scene", "Typed start"],
  epoch2: [U(25), "Epoch two", "Epoch two text"],
  race: [U(26), "Race scene", "Race text"],
  sess: [U(27), "Session scene", "Session text"],
  hide: [U(28), "Hide small", "Small text"],
  unmount: [U(30), "Unmount one", "Unmount text"],
  big: [U(29), "Big text", "語".repeat(55_000)],
} as const;
const FRONT_MATTER_ID = SCENES.fm[0];
const FORMATTING = fixture("formatting");
const STRUCTURE = fixture("structure");

const doc = (nodeId: string, text: string) => ({
  schema: "writers-rolltop/document", version: 1, nodeId,
  blocks: [{ id: randomUUID(), type: "paragraph", content: [{ type: "text", text }] }],
});
const textOf = (d: any): string => d.blocks.map((b: any) => (b.content ?? []).map((i: any) => i.text ?? "\n").join("")).join("\n");

async function apiLogin(): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: BASE });
  const res = await api.post("/api/auth/login", { data: { password: PASSWORD } });
  expect(res.ok()).toBeTruthy();
  return api;
}
async function epochOf(api: APIRequestContext): Promise<string> {
  const r = await api.get(`/api/sync/v1/changes?epoch=${randomUUID()}&after=0`);
  expect(r.status()).toBe(409);
  return (await r.json()).epoch;
}
async function pushAll(api: APIRequestContext, ops: unknown[]) {
  const r = await api.post("/api/sync/v1/push", { data: { epoch: await epochOf(api), deviceId: randomUUID(), ops } });
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.results.map((x: any) => x.status)).toEqual(ops.map(() => "applied"));
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
/** The newest saved document of a node: its revision and value. */
async function savedDoc(api: APIRequestContext, nodeId: string): Promise<{ revision: number; value: any }> {
  const docs = (await feed(api)).filter((c) => c.recordKind === "document" && c.recordId === nodeId);
  const last = docs[docs.length - 1];
  return { revision: last?.revision ?? 0, value: last?.value };
}
async function openConflicts(api: APIRequestContext): Promise<any[]> {
  const j = await (await api.get(`/api/sync/v1/conflicts?epoch=${await epochOf(api)}`)).json();
  return j.conflicts;
}

const create = (recordKind: string, value: Record<string, unknown>) => ({ opId: randomUUID(), op: "create", recordKind, recordId: value.id, value });
const docOp = (nodeId: string, text: string) => ({ opId: randomUUID(), op: "document", recordKind: "document", recordId: nodeId, baseRevision: 0, value: doc(nodeId, text) });
const sceneRecord = (id: string, title: string, key: string) => id === FRONT_MATTER_ID
  ? { id, bookId: BOOK, kind: "frontMatter", title, orderKey: key, createdAt: T, updatedAt: T } // front matter has no parent
  : { id, bookId: BOOK, parentId: CHAPTER, kind: "scene", title, orderKey: key, createdAt: T, updatedAt: T };

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}
/** A new browser context: its own cookies, localStorage and IndexedDB. The server is asked for changes only on demand. */
async function newDevice(browser: Browser, extra: Record<string, unknown> = {}, pollMs = 0): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: DESKTOP, ...extra });
  await ctx.addInitScript((ms) => { window.__ROLLTOP_POLL_MS__ = ms; }, pollMs);
  const page = await ctx.newPage();
  await signIn(page);
  return { ctx, page };
}
async function openScene(page: Page, title: string) {
  await page.getByRole("list", { name: "Manuscript outline" }).getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByRole("textbox", { name: `${title} text` })).toBeVisible();
}
const editorOf = (page: Page, title: string) => page.getByRole("textbox", { name: `${title} text` });
const statusLine = (page: Page) => page.locator("#editor-note");

/** Caret to the end of the line (the End key only scrolls on macOS). */
const lineEnd = (page: Page) => page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");

/** Types at the end of the first line of a scene. */
async function typeAtEnd(page: Page, title: string, text: string) {
  const ed = editorOf(page, title);
  await ed.click();
  await lineEnd(page);
  await page.keyboard.type(text);
}

const idb = (page: Page, store: "recovery" | "held"): Promise<any[]> => page.evaluate(([name, s]) => new Promise<any[]>((ok, no) => {
  const r = indexedDB.open(name!);
  r.onerror = () => no(r.error);
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains(s!)) { db.close(); ok([]); return; }
    const g = db.transaction(s!).objectStore(s!).getAll();
    g.onsuccess = () => { db.close(); ok(g.result); };
    g.onerror = () => no(g.error);
  };
}), [`rolltop-library-${LIB}`, store] as const);

let api: APIRequestContext;
test.beforeAll(async () => { api = await apiLogin(); });
test.afterAll(async () => { await api.dispose(); });

test("a library whose change feed is mocked empty is not shown as an empty manuscript: editing is off and the reason is plain", async ({ browser }) => {
  // The server really holds a library (made next, by sync), but the feed is made to look like an imported library's: empty.
  await pushAll(api, [
    create("library", { id: LIB, title: "Test library", createdAt: T, updatedAt: T }),
    create("book", { id: BOOK, title: "Test Book", orderKey: "m", createdAt: T, updatedAt: T }),
    create("manuscriptNode", { id: CHAPTER, bookId: BOOK, kind: "chapter", title: "Chapter One", orderKey: "m", createdAt: T, updatedAt: T }),
    ...Object.values(SCENES).flatMap(([id, title, text], i) => [create("manuscriptNode", sceneRecord(id, title, `m${String.fromCharCode(97 + i)}`)), docOp(id, text)]),
    create("manuscriptNode", sceneRecord(FORMATTING.nodeId, "Formatting fixture", "n1")), { ...docOp(FORMATTING.nodeId, ""), value: FORMATTING },
    create("manuscriptNode", sceneRecord(STRUCTURE.nodeId, "Structure fixture", "n2")), { ...docOp(STRUCTURE.nodeId, ""), value: STRUCTURE },
  ]);
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await page.route("**/api/sync/v1/changes*", (route) => {
    const epoch = new URL(route.request().url()).searchParams.get("epoch");
    return route.fulfill({ json: { epoch, head: 0, changes: [], next: 0 } });
  });
  await signIn(page);
  await expect(page.getByRole("heading", { name: "This library needs a baseline" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("imported");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Manuscript outline" })).toHaveCount(0);
  await expect(page.getByText("Chapter One")).toHaveCount(0);
  await ctx.close();
});

test("a library made through sync shows its books and scenes; the sample notice stays for the parts that are still samples", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  await expect(page.getByRole("button", { name: "Book: Test Book. Change book" })).toBeVisible();
  const outline = page.getByRole("list", { name: "Manuscript outline" });
  await expect(outline.getByText("Chapter One")).toBeVisible();
  await expect(outline.getByRole("button", { name: "Leave scene", exact: true })).toBeVisible();
  const notice = page.getByRole("region", { name: "Sample content notice" });
  await expect(notice).toContainText("Sample content");
  await expect(notice).toContainText("not connected");
  await expect(page.getByRole("heading", { name: "Quick Notes (sample)" })).toBeVisible();
  // Nothing is stored on this device until it has something to keep: no device id before the first push.
  expect(await page.evaluate(() => localStorage.getItem("rolltop.deviceId"))).toBeNull();
  await ctx.close();
});

test("save on leave: typing does not save; leaving the field saves; Saving shows until the server answers, then Saved", async ({ browser }) => {
  const [id, title, text] = SCENES.leave;
  const { ctx, page } = await newDevice(browser);
  const pushes: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route("**/api/sync/v1/push", async (route) => { pushes.push(route.request().postData() ?? ""); await gate; await route.continue(); });
  await openScene(page, title);
  await expect(statusLine(page)).toHaveText("No changes yet.");
  const before = await savedDoc(api, id);
  expect(before.revision).toBe(1);
  await typeAtEnd(page, title, " and more");
  await page.waitForTimeout(1500); // longer than the local draft delay: still nothing is sent
  expect(pushes).toHaveLength(0);
  await expect(statusLine(page)).toHaveText("Not saved yet. Your text is kept on this device.");
  expect((await savedDoc(api, id)).revision).toBe(1);
  // The text is already on this device (IndexedDB) although the server has not seen it.
  await expect.poll(async () => (await idb(page, "held")).map((h) => textOf(h.doc))).toEqual([`${text} and more`]);
  await editorOf(page, title).blur();
  await expect(statusLine(page)).toHaveText("Saving");
  expect(pushes).toHaveLength(1);
  expect(JSON.parse(pushes[0]!).ops).toHaveLength(1);
  expect(JSON.parse(pushes[0]!).ops[0]).toMatchObject({ op: "document", recordId: id, baseRevision: 1 });
  expect(await statusLine(page).innerText()).not.toBe("Saved"); // the server has not answered
  expect((await savedDoc(api, id)).revision).toBe(1);
  release();
  await expect(statusLine(page)).toHaveText("Saved");
  await page.screenshot({ path: `${SHOTS}/editor-live-1280.png` });
  const after = await savedDoc(api, id);
  expect(after.revision).toBe(2);
  expect(textOf(after.value)).toBe(`${text} and more`);
  await expect.poll(async () => (await idb(page, "held")).length).toBe(0);
  // The device id exists now, is a uuid, and is stored in this profile only.
  expect(await page.evaluate(() => localStorage.getItem("rolltop.deviceId"))).toMatch(/^[0-9a-f-]{36}$/);
  await ctx.close();
});

test("a failed save keeps the text on the device, says Not saved yet, survives a reload, and saves with Save now", async ({ browser }) => {
  const [id, title, text] = SCENES.fail;
  const { ctx, page } = await newDevice(browser);
  const sentOps: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/sync/v1/push")) sentOps.push(JSON.parse(r.postData() ?? "{}").ops?.[0]?.opId); });
  await page.route("**/api/sync/v1/push", (route) => route.abort("connectionfailed"));
  await openScene(page, title);
  await typeAtEnd(page, title, " typed offline");
  await editorOf(page, title).blur();
  await expect(statusLine(page)).toHaveText("Not saved yet. Your text is kept on this device.");
  expect((await savedDoc(api, id)).revision).toBe(1);
  const held = await idb(page, "held");
  expect(held.map((h) => textOf(h.doc))).toEqual([`${text} typed offline`]);
  // Reload: the text comes back from the device.
  await page.reload();
  await openScene(page, title);
  await expect(editorOf(page, title)).toContainText(`${text} typed offline`);
  await expect(statusLine(page)).toHaveText("Not saved yet. Your text is kept on this device.");
  await page.unroute("**/api/sync/v1/push");
  await page.getByRole("button", { name: "Save now" }).click();
  await expect(statusLine(page)).toHaveText("Saved");
  expect(textOf((await savedDoc(api, id)).value)).toBe(`${text} typed offline`);
  // A retry after a lost answer is the same op (same op id), so it can never apply twice.
  expect(sentOps.length).toBeGreaterThanOrEqual(2);
  expect(new Set(sentOps).size).toBe(1);
  expect((await savedDoc(api, id)).revision).toBe(2);
  await expect.poll(async () => (await idb(page, "held")).length).toBe(0);
  await ctx.close();
});

test("editor round trip in the browser: the adapter fixtures formatting.json and structure.json come back identical after a save", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  for (const [fx, title, heading] of [[FORMATTING, "Formatting fixture", "The letter"], [STRUCTURE, "Structure fixture", "Part One"]] as const) {
    await openScene(page, title);
    const ed = editorOf(page, title);
    await expect(ed.getByRole("heading", { name: heading })).toBeVisible();
    if (fx === FORMATTING) {
      await expect(ed.locator("em", { hasText: /^just$/ })).toBeVisible();
      await expect(ed.locator("strong", { hasText: "Mara" })).toBeVisible();
      await expect(ed.locator("[data-anchor]").first()).toBeVisible();
    } else {
      await expect(ed.locator(".rt-ordered")).toHaveCount(3);
      await expect(ed.locator(".rt-break")).toHaveCount(1);
    }
    await ed.getByRole("heading", { name: heading }).click();
    await lineEnd(page);
    await page.keyboard.type("!");
    await ed.blur();
    await expect(statusLine(page)).toHaveText("Saved");
    const expected = structuredClone(fx);
    expected.blocks[0].content[0].text += "!";
    const saved = await savedDoc(api, fx.nodeId);
    expect(saved.revision).toBe(2);
    expect(saved.value).toEqual(expected); // every other block, mark, anchor, list level and id is unchanged
  }
  await ctx.close();
});

test("the toolbar works with mouse and keyboard; the saved marks are in the canonical order; Reduced Motion removes transitions", async ({ browser }) => {
  const [id, title] = SCENES.tools;
  const { ctx, page } = await newDevice(browser, { reducedMotion: "reduce" });
  await openScene(page, title);
  const bar = page.getByRole("toolbar", { name: "Formatting" });
  for (const name of ["Undo", "Redo", "Bold", "Italic", "Underline", "Bulleted list", "Numbered list", "Expand editor"]) {
    await expect(bar.getByRole("button", { name })).toBeVisible();
  }
  expect(await bar.getByRole("button", { name: "Bold" }).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  await editorOf(page, title).click();
  await page.keyboard.press("ControlOrMeta+a");
  // Underline, then italic, then bold: the saved order must still be strong, emphasis, underline.
  await bar.getByRole("button", { name: "Underline" }).click();
  await bar.getByRole("button", { name: "Italic" }).click();
  await bar.getByRole("button", { name: "Bold" }).focus();
  await page.keyboard.press("Enter"); // keyboard works on the toolbar
  for (const name of ["Bold", "Italic", "Underline"]) await expect(bar.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  await expect(editorOf(page, title).locator("strong em u, strong u em, em strong u, u em strong, em u strong, u strong em").first()).toBeVisible();
  await bar.getByRole("button", { name: "Bulleted list" }).click();
  await expect(bar.getByRole("button", { name: "Bulleted list" })).toHaveAttribute("aria-pressed", "true");
  await editorOf(page, title).blur();
  await expect(statusLine(page)).toHaveText("Saved");
  // (Moving focus to a toolbar button by keyboard also left the field once, which saved once already.)
  await expect.poll(async () => (await savedDoc(api, id)).value.blocks[0].list).toEqual({ style: "bullet", level: 0 });
  const saved = await savedDoc(api, id);
  expect(saved.revision).toBeGreaterThanOrEqual(2);
  expect(saved.value.blocks[0].content[0].marks).toEqual([{ type: "strong" }, { type: "emphasis" }, { type: "underline" }]);
  // Undo takes the list off again, Redo puts it back.
  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(bar.getByRole("button", { name: "Bulleted list" })).toHaveAttribute("aria-pressed", "false");
  await bar.getByRole("button", { name: "Redo" }).click();
  await expect(bar.getByRole("button", { name: "Bulleted list" })).toHaveAttribute("aria-pressed", "true");
  // Every visible control is at least 44 px.
  const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button, a[href], input")]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => { const r = el.getBoundingClientRect(); return { n: el.getAttribute("aria-label") ?? el.textContent, w: r.width, h: r.height }; })
    .filter((t) => t.w < 43.99 || t.h < 43.99));
  expect(small).toEqual([]);
  await ctx.close();
});

test("changing to another scene saves the one being left", async ({ browser }) => {
  const [id1, t1, x1] = SCENES.one;
  const [, t2] = SCENES.two;
  const { ctx, page } = await newDevice(browser);
  await openScene(page, t1);
  await typeAtEnd(page, t1, " switched");
  await openScene(page, t2); // no blur by hand: the editor goes away
  await expect.poll(async () => textOf((await savedDoc(api, id1)).value)).toBe(`${x1} switched`);
  await ctx.close();
});

test("changing scene with its blur swallowed still saves the one being left (the unmount cleanup)", async ({ browser }) => {
  const [id1, t1, x1] = SCENES.unmount;
  const [, t2] = SCENES.two;
  const { ctx, page } = await newDevice(browser);
  await openScene(page, t1);
  await typeAtEnd(page, t1, " unmounted");
  // Chrome fires a blur when the focused editor is removed, so swallow every blur and focusout before the editor can see
  // it (capture phase on window): the blur save cannot run, and only the unmount cleanup can save the text.
  await page.evaluate(() => {
    (window as any).__lost = 0;
    for (const type of ["blur", "focusout"]) window.addEventListener(type, (e) => { (window as any).__lost++; e.stopImmediatePropagation(); }, true);
  });
  await page.evaluate((title) => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Manuscript outline"] button')].find((x) => x.textContent?.trim() === title);
    if (!b) throw new Error("no outline button");
    b.click();
  }, t2);
  await expect(editorOf(page, t2)).toBeVisible();
  await expect.poll(async () => textOf((await savedDoc(api, id1)).value)).toBe(`${x1} unmounted`);
  await ctx.close();
});

/** Two devices edit one scene: A saves first, then B saves from the same old revision and gets a conflict. */
async function makeConflict(browser: Browser, key: "both" | "mine" | "saved" | "fm" | "cboth" | "crefuse") {
  const [id, title] = SCENES[key];
  const a = await newDevice(browser);
  const b = await newDevice(browser);
  await openScene(a.page, title);
  await openScene(b.page, title);
  await typeAtEnd(a.page, title, " + text from A");
  await editorOf(a.page, title).blur();
  await expect(statusLine(a.page)).toHaveText("Saved");
  await typeAtEnd(b.page, title, " + text from B");
  await editorOf(b.page, title).blur();
  const dialog = b.page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return { id, title, a, b, dialog };
}

test("two browser sessions edit one scene: both texts are kept, recovery is offered on the second, and resolving clears the item only after the server answers", async ({ browser }) => {
  const { id, title, a, b, dialog } = await makeConflict(browser, "both");
  // Different devices.
  const idA = await a.page.evaluate(() => localStorage.getItem("rolltop.deviceId"));
  const idB = await b.page.evaluate(() => localStorage.getItem("rolltop.deviceId"));
  expect(idA).toMatch(/^[0-9a-f-]{36}$/);
  expect(idB).toMatch(/^[0-9a-f-]{36}$/);
  expect(idA).not.toBe(idB);
  // The plain recovery panel: which scene, what happened, both versions side by side; focus is inside it.
  await expect(dialog).toHaveAccessibleName(`Another copy of "${title}" was saved on another device`);
  await expect(dialog.getByRole("heading", { level: 2 })).toBeFocused();
  await expect(dialog.getByRole("region", { name: "This device's text" })).toHaveText("Shared start + text from B");
  await expect(dialog.getByRole("region", { name: "Saved text" })).toHaveText("Shared start + text from A");
  for (const name of ["Keep this device's text", "Keep the saved text", "Keep both", "Decide later"]) {
    await expect(dialog.getByRole("button", { name })).toBeVisible();
  }
  // Both texts are kept. Server: the saved one (A) is the scene's text, and the losing one (B) is an open conflict.
  const saved = await savedDoc(api, id);
  expect(textOf(saved.value)).toBe("Shared start + text from A");
  expect(saved.revision).toBe(2);
  const open = await openConflicts(api);
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ kind: "document", recordId: id });
  expect(textOf(open[0].losing.value)).toBe("Shared start + text from B");
  // This device: the losing text is in IndexedDB, keyed by scene and conflict id, and survives a reload.
  const items = await idb(b.page, "recovery");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ sceneId: id, conflictId: open[0].conflictId, source: "conflict" });
  expect(textOf(items[0].mine)).toBe("Shared start + text from B");
  expect(textOf(items[0].theirs)).toBe("Shared start + text from A");
  await b.page.screenshot({ path: `${SHOTS}/recovery-desktop-1280.png` });
  await b.page.setViewportSize({ width: 390, height: 844 });
  await b.page.screenshot({ path: `${SHOTS}/recovery-phone-390.png` });
  expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await b.page.setViewportSize(DESKTOP);
  // The dialog's controls are at least 44 px.
  const small = await dialog.evaluate((d) => [...d.querySelectorAll<HTMLElement>("button")].map((el) => el.getBoundingClientRect()).filter((r) => r.width < 43.99 || r.height < 43.99).length);
  expect(small).toBe(0);
  // Escape closes the panel without deciding; the copy stays and can be reopened.
  await b.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(statusLine(b.page)).toContainText("Not saved yet");
  await expect(editorOf(b.page, title)).toHaveAttribute("contenteditable", "false");
  await b.page.getByRole("button", { name: "Review the other copy" }).click();
  await expect(dialog).toBeVisible();
  await b.page.reload();
  await openScene(b.page, title);
  await expect(b.page.getByRole("dialog")).toBeVisible();
  await expect(b.page.getByRole("dialog").getByRole("region", { name: "This device's text" })).toHaveText("Shared start + text from B");
  // Keep both, with the server's answer held back.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let pushed = 0;
  await b.page.route("**/api/sync/v1/push", async (route) => { pushed++; await gate; await route.continue(); });
  await b.page.getByRole("dialog").getByRole("button", { name: "Keep both" }).click();
  await expect.poll(() => pushed).toBe(1);
  await expect(b.page.getByRole("dialog")).toBeVisible();
  expect(await idb(b.page, "recovery")).toHaveLength(1); // still there: the server has not answered
  expect(await openConflicts(api)).toHaveLength(1);
  release();
  await expect(b.page.getByRole("dialog")).toBeHidden();
  expect(await idb(b.page, "recovery")).toHaveLength(0);
  expect(await openConflicts(api)).toHaveLength(0);
  // The scene now has B's text; the saved copy (A's text) is a new scene next to it.
  const now = await savedDoc(api, id);
  expect(textOf(now.value)).toBe("Shared start + text from B");
  expect(now.revision).toBe(3);
  const created = (await feed(api)).find((c) => c.change === "create" && c.value?.title === `${title} (saved copy)`);
  expect(created).toBeDefined();
  expect(textOf((await savedDoc(api, created.recordId)).value)).toBe("Shared start + text from A");
  await expect(editorOf(b.page, title)).toContainText("Shared start + text from B");
  await expect(editorOf(b.page, title)).toHaveAttribute("contenteditable", "true");
  await expect(b.page.getByRole("list", { name: "Manuscript outline" }).getByRole("button", { name: `${title} (saved copy)` })).toBeVisible();
  await a.ctx.close();
  await b.ctx.close();
});

test("recovery: keeping this device's text saves it over the saved text and closes the conflict", async ({ browser }) => {
  const { id, a, b, dialog } = await makeConflict(browser, "mine");
  await dialog.getByRole("button", { name: "Keep this device's text" }).click();
  await expect(dialog).toBeHidden();
  expect(textOf((await savedDoc(api, id)).value)).toBe("Shared start + text from B");
  expect(await openConflicts(api)).toHaveLength(0);
  expect(await idb(b.page, "recovery")).toHaveLength(0);
  await a.ctx.close();
  await b.ctx.close();
});

test("recovery: keeping the saved text loads it, leaves the server as it is, and closes the conflict", async ({ browser }) => {
  const [, title] = SCENES.saved;
  const { id, a, b, dialog } = await makeConflict(browser, "saved");
  await dialog.getByRole("button", { name: "Keep the saved text" }).click();
  await expect(dialog).toBeHidden();
  const s = await savedDoc(api, id);
  expect(textOf(s.value)).toBe("Shared start + text from A");
  expect(s.revision).toBe(2);
  expect(await openConflicts(api)).toHaveLength(0);
  expect(await idb(b.page, "recovery")).toHaveLength(0);
  await expect(editorOf(b.page, title)).toContainText("Shared start + text from A");
  await expect(editorOf(b.page, title)).toHaveAttribute("contenteditable", "true");
  await a.ctx.close();
  await b.ctx.close();
});

test("a base problem in the same epoch (409) is held for the author: the text is not re-sent, and it is kept", async ({ browser }) => {
  const [id, title, text] = SCENES.refused;
  const { ctx, page } = await newDevice(browser);
  let pushes = 0;
  await page.route("**/api/sync/v1/push", async (route) => {
    pushes++;
    const epoch = await epochOf(api);
    await route.fulfill({ status: 409, json: { error: { code: "RESYNC_REQUIRED", message: "The epoch or cursor is not valid for this library. Pull again from the start." }, epoch, head: 1 } });
  });
  await openScene(page, title);
  await typeAtEnd(page, title, " held");
  await editorOf(page, title).blur();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("could not be saved");
  await expect(dialog).toContainText("does not have the version this text was written on");
  await expect(dialog.getByRole("region", { name: "This device's text" })).toHaveText(`${text} held`);
  await page.waitForTimeout(1200);
  expect(pushes).toBe(1);
  expect((await savedDoc(api, id)).revision).toBe(1);
  const items = await idb(page, "recovery");
  expect(items).toHaveLength(1);
  expect(items[0].source).toBe("refused");
  expect(await idb(page, "held")).toHaveLength(0); // it moved into the recovery store, it did not vanish
  await dialog.getByRole("button", { name: "Keep the saved text" }).click(); // no server step is needed for this one
  await expect(dialog).toBeHidden();
  expect(await idb(page, "recovery")).toHaveLength(0);
  await ctx.close();
});

test("a changed epoch sends unsaved text to the author; it is not re-sent under the new epoch", async ({ browser }) => {
  const [id, title, text] = SCENES.epoch;
  const { ctx, page } = await newDevice(browser);
  let pushes = 0;
  await page.route("**/api/sync/v1/push", async (route) => {
    pushes++;
    await route.fulfill({ status: 409, json: { error: { code: "RESYNC_REQUIRED", message: "x" }, epoch: randomUUID(), head: 0 } });
  });
  await openScene(page, title);
  await typeAtEnd(page, title, " old epoch");
  await editorOf(page, title).blur();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("restored or replaced");
  await expect(dialog.getByRole("region", { name: "This device's text" })).toHaveText(`${text} old epoch`);
  await page.waitForTimeout(1000);
  expect(pushes).toBe(1);
  expect((await savedDoc(api, id)).revision).toBe(1);
  await ctx.close();
});

test("signing out saves the open scene first", async ({ browser }) => {
  const [id, title, text] = SCENES.out;
  const { ctx, page } = await newDevice(browser);
  await openScene(page, title);
  await typeAtEnd(page, title, " before sign out");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(textOf((await savedDoc(api, id)).value)).toBe(`${text} before sign out`);
  await ctx.close();
});

const PUSH = "**/api/sync/v1/push";
const CHANGES = "**/api/sync/v1/changes*";
const pushBody = (route: { request(): { postData(): string | null } }): any => JSON.parse(route.request().postData() ?? "{}");

// ---------- M1-9 review fixes ----------

test("A: front matter offers no copy; keep both is not shown, and the scene is not overwritten", async ({ browser }) => {
  const [id, title] = SCENES.fm;
  const { a, b, dialog } = await makeConflict(browser, "fm");
  await expect(dialog.getByRole("button", { name: "Keep this device's text" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep the saved text" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep both" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /new scene/ })).toHaveCount(0);
  const saved = await savedDoc(api, id);
  expect(textOf(saved.value)).toBe("Shared start + text from A");
  expect(saved.revision).toBe(2);
  expect((await feed(api)).filter((c) => c.change === "create" && String(c.value?.title ?? "").startsWith(`${title} (`))).toHaveLength(0);
  await dialog.getByRole("button", { name: "Keep the saved text" }).click();
  await expect(dialog).toBeHidden();
  expect(textOf((await savedDoc(api, id)).value)).toBe("Shared start + text from A");
  await a.ctx.close();
  await b.ctx.close();
});

test("A: keep both makes the copy first (same kind and parent), then overwrites the scene; a lost answer is a retry of the same ops", async ({ browser }) => {
  const [id, title] = SCENES.cboth;
  const { a, b, dialog } = await makeConflict(browser, "cboth");
  const pushes: any[] = [];
  let lose = true;
  await b.page.route(PUSH, async (route) => {
    pushes.push(pushBody(route));
    if (lose) return route.abort("connectionfailed");
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Keep both" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not reach the server");
  expect(pushes).toHaveLength(1);
  expect(pushes[0].ops.map((o: any) => o.op)).toEqual(["create", "document"]); // the copy only
  expect(pushes[0].ops[1].recordId).toBe(pushes[0].ops[0].recordId);
  expect((await savedDoc(api, id)).revision).toBe(2); // the scene is untouched
  lose = false;
  await dialog.getByRole("button", { name: "Keep both" }).click();
  await expect(dialog).toBeHidden();
  expect(pushes).toHaveLength(3);
  expect(pushes[1].ops.map((o: any) => o.opId)).toEqual(pushes[0].ops.map((o: any) => o.opId)); // same content: same op ids
  expect(pushes[2].ops.map((o: any) => o.op)).toEqual(["document", "resolve"]);
  expect(pushes[2].ops[0]).toMatchObject({ recordId: id, baseRevision: 2 });
  const copy = pushes[1].ops[0];
  expect(copy.value).toMatchObject({ kind: "scene", parentId: CHAPTER, bookId: BOOK, title: `${title} (saved copy)` });
  const changes = await feed(api);
  const createSeq = changes.find((c) => c.change === "create" && c.recordId === copy.recordId)?.seq;
  const overwriteSeq = changes.filter((c) => c.recordKind === "document" && c.recordId === id).at(-1)?.seq;
  expect(createSeq).toBeLessThan(overwriteSeq);
  expect(textOf((await savedDoc(api, copy.recordId)).value)).toBe("Shared start + text from A");
  const now = await savedDoc(api, id);
  expect(textOf(now.value)).toBe("Shared start + text from B");
  expect(now.revision).toBe(3);
  expect(await openConflicts(api)).toHaveLength(0);
  await a.ctx.close();
  await b.ctx.close();
});

test("A: a refused copy leaves the scene unchanged and sends no second push; the text stays; a retry uses new op ids", async ({ browser }) => {
  const [id, title] = SCENES.crefuse;
  const { a, b, dialog } = await makeConflict(browser, "crefuse");
  const pushes: any[] = [];
  let refuse = true;
  await b.page.route(PUSH, async (route) => {
    const body = pushBody(route);
    pushes.push(body);
    if (refuse) {
      return route.fulfill({ json: { epoch: body.epoch, head: 1, results: body.ops.map((o: any) => ({ opId: o.opId, status: "rejected", code: "INTEGRITY_VIOLATION", message: "refused" })) } });
    }
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Keep both" }).click();
  await expect(dialog.getByRole("alert")).toContainText("scene was left as it was");
  await expect(dialog.getByRole("alert")).toContainText("sent as a new request");
  await b.page.waitForTimeout(500);
  expect(pushes).toHaveLength(1); // no second push
  expect(pushes[0].ops.map((o: any) => o.op)).toEqual(["create", "document"]);
  const saved = await savedDoc(api, id);
  expect(textOf(saved.value)).toBe("Shared start + text from A");
  expect(saved.revision).toBe(2);
  expect(await openConflicts(api)).toHaveLength(1);
  const items = await idb(b.page, "recovery");
  expect(items).toHaveLength(1);
  expect(textOf(items[0].mine)).toBe("Shared start + text from B"); // B's text is still kept on the device
  await expect(dialog.getByRole("region", { name: "This device's text" })).toHaveText("Shared start + text from B");
  // A refused op id is permanent: the retry has new ids.
  refuse = false;
  await dialog.getByRole("button", { name: "Keep both" }).click();
  await expect(dialog).toBeHidden();
  expect(pushes).toHaveLength(3);
  const refusedIds = new Set(pushes[0].ops.map((o: any) => o.opId));
  for (const o of pushes[1].ops) expect(refusedIds.has(o.opId)).toBe(false);
  expect(textOf((await savedDoc(api, id)).value)).toBe("Shared start + text from B");
  expect((await feed(api)).some((c) => c.change === "create" && c.value?.title === `${title} (saved copy)`)).toBe(true);
  await a.ctx.close();
  await b.ctx.close();
});

test("B: a conflict that arrives from a poll while the author has unsaved text keeps that text as its own recovery item and shows it", async ({ browser }) => {
  const [id, title, text] = SCENES.typed;
  const { ctx, page } = await newDevice(browser, {}, 400);
  let pushes = 0;
  page.on("request", (r) => { if (r.url().endsWith("/api/sync/v1/push")) pushes++; });
  await openScene(page, title);
  await typeAtEnd(page, title, " typed here");
  // Another device's stale text makes a conflict on the server; this page learns of it by polling.
  const r = await api.post("/api/sync/v1/push", { data: { epoch: await epochOf(api), deviceId: randomUUID(), ops: [docOp(id, "Other device text")] } });
  expect((await r.json()).results[0].status).toBe("conflict");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: "This device's text" })).toHaveText("Other device text");
  await expect(dialog.getByRole("region", { name: "Other text kept on this device 1" })).toHaveText(`${text} typed here`);
  await expect(dialog).toContainText("had not been saved when another copy of this scene came in");
  await expect.poll(async () => (await idb(page, "recovery")).map((i) => i.source).sort()).toEqual(["conflict", "unsent"]);
  const unsent = (await idb(page, "recovery")).find((i) => i.source === "unsent");
  expect(textOf(unsent.mine)).toBe(`${text} typed here`);
  expect(await idb(page, "held")).toHaveLength(0); // moved into recovery, not kept twice
  expect(pushes).toBe(0);
  // Deciding about the first pair brings up the typed text as the next one; nothing was lost on the way.
  await dialog.getByRole("button", { name: "Keep the saved text" }).click();
  await expect(dialog.getByRole("region", { name: "This device's text" })).toHaveText(`${text} typed here`);
  await expect(dialog.getByRole("region", { name: /Other text kept/ })).toHaveCount(0);
  expect(await openConflicts(api)).toHaveLength(0);
  await ctx.close();
});

test("C: an epoch change holds the text on screen; it is not pushed under the new epoch or with an old revision", async ({ browser }) => {
  const [id, title, text] = SCENES.epoch2;
  const { ctx, page } = await newDevice(browser, {}, 150);
  const newEpoch = randomUUID();
  const realEpoch = await epochOf(api);
  let fake = false;
  const pushes: any[] = [];
  // The page is told the library has a new history (same records, so the scene stays open) under another epoch id.
  await page.route(CHANGES, async (route) => {
    if (!fake) return route.continue();
    const url = new URL(route.request().url());
    if (url.searchParams.get("epoch") !== newEpoch) return route.fulfill({ status: 409, json: { error: { code: "RESYNC_REQUIRED", message: "x" }, epoch: newEpoch, head: 0 } });
    url.searchParams.set("epoch", realEpoch);
    const real = await (await route.fetch({ url: url.toString() })).json();
    return route.fulfill({ json: { ...real, epoch: newEpoch } });
  });
  await page.route("**/api/sync/v1/conflicts*", (route) => (fake ? route.fulfill({ json: { conflicts: [] } }) : route.continue()));
  await page.route(PUSH, async (route) => { pushes.push(pushBody(route)); await route.continue(); });
  await openScene(page, title);
  await typeAtEnd(page, title, " typed before");
  fake = true; // the next poll sees a different history
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("restored or replaced");
  await expect(dialog.getByRole("region", { name: "This device's text" })).toHaveText(`${text} typed before`);
  const mine = async () => (await idb(page, "recovery")).filter((i) => i.sceneId === id).map((i) => textOf(i.mine));
  await expect.poll(mine).toEqual([`${text} typed before`]);
  await page.waitForTimeout(800);
  expect(pushes).toHaveLength(0);
  expect(await mine()).toHaveLength(1); // one item, not two
  await ctx.close();
});

test("D: a pull that started before a save does not bring back the older text; a pull asked for meanwhile runs after it", async ({ browser }) => {
  const [id, title, text] = SCENES.race;
  const { ctx, page } = await newDevice(browser);
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let release2!: () => void;
  const gate2 = new Promise<void>((r) => { release2 = r; });
  let calls = 0;
  await page.route(CHANGES, async (route) => {
    const n = ++calls;
    if (!hold) return route.continue();
    if (n > 1) { await gate2; return route.continue(); } // a later pull is kept waiting, so it cannot repair the screen
    const answer = await route.fetch(); // the answer is made now, from the server as it is now (revision 2)
    await gate;
    await route.fulfill({ response: answer });
  });
  await openScene(page, title);
  hold = true;
  await typeAtEnd(page, title, " one");
  await editorOf(page, title).blur();
  await expect(statusLine(page)).toHaveText("Saved"); // revision 2; the pull this started is held
  await expect.poll(() => calls).toBe(1);
  const callsBefore = calls;
  await typeAtEnd(page, title, " two");
  await editorOf(page, title).blur();
  await expect.poll(async () => (await savedDoc(api, id)).revision).toBe(3);
  await expect(statusLine(page)).toHaveText("Saved");
  release(); // the older answer (revision 2) arrives now
  await expect.poll(() => calls - callsBefore).toBeGreaterThanOrEqual(1); // the pull asked for after the second save was not dropped
  await page.waitForTimeout(700); // the older answer has been applied; the later pull is still waiting
  await expect(editorOf(page, title)).toContainText(`${text} one two`);
  await expect(statusLine(page)).toHaveText("Saved");
  expect(textOf((await savedDoc(api, id)).value)).toBe(`${text} one two`);
  release2();
  await page.waitForTimeout(500);
  await expect(editorOf(page, title)).toContainText(`${text} one two`);
  await ctx.close();
});

test("M1: when the session ends while typing, the text is kept on the device, the notice says so, and it comes back after signing in", async ({ browser }) => {
  const [id, title, text] = SCENES.sess;
  const { ctx, page } = await newDevice(browser, {}, 300);
  await openScene(page, title);
  await typeAtEnd(page, title, " typed as the session ends");
  await ctx.clearCookies(); // the server no longer knows this session
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Your sign-in ended.")).toContainText("kept on this device");
  await expect.poll(async () => (await idb(page, "held")).map((h) => textOf(h.doc))).toEqual([`${text} typed as the session ends`]);
  expect((await savedDoc(api, id)).revision).toBe(1);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await openScene(page, title);
  await expect(editorOf(page, title)).toContainText(`${text} typed as the session ends`);
  // The text is saved when the scene is opened again or with Save now, whichever comes first.
  const saveNow = page.getByRole("button", { name: "Save now" });
  await expect.poll(async () => {
    if (await saveNow.isVisible()) await saveNow.click({ timeout: 1000 }).catch(() => {});
    return textOf((await savedDoc(api, id)).value);
  }).toBe(`${text} typed as the session ends`);
  await expect(statusLine(page)).toHaveText("Saved");
  await ctx.close();
});

test("M2: signing out while the studio is still starting leaves no poll timer behind", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 200; });
  const page = await ctx.newPage();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let waiting = 0;
  await page.route("**/api/sync/v1/conflicts*", async (route) => { waiting++; await gate; await route.continue(); });
  await signIn(page);
  await expect.poll(() => waiting).toBe(1); // the studio is in becomeReady, waiting for the conflicts
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  let after = 0;
  page.on("request", (r) => { if (r.url().includes("/api/sync/v1/")) after++; });
  release();
  await page.waitForTimeout(1200); // six poll intervals
  expect(after).toBe(0);
  await ctx.close();
});

test("M3: a text of 55,000 non-ASCII characters is not sent when the page hides, and stays held on the device; a small one is sent", async ({ browser }) => {
  const [, smallTitle] = SCENES.hide;
  const [bigId, bigTitle, bigText] = SCENES.big;
  const small = await newDevice(browser);
  const sent: any[] = [];
  small.page.on("request", (r) => { if (r.url().endsWith("/api/sync/v1/push")) sent.push(JSON.parse(r.postData() ?? "{}")); });
  await openScene(small.page, smallTitle);
  await typeAtEnd(small.page, smallTitle, "!");
  await small.page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => sent.length).toBe(1);
  await small.ctx.close();

  const { ctx, page } = await newDevice(browser);
  const pushes: unknown[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/sync/v1/push")) pushes.push(r.postData()); });
  await openScene(page, bigTitle);
  await expect(editorOf(page, bigTitle)).toContainText(bigText.slice(0, 20));
  await typeAtEnd(page, bigTitle, "x");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(800);
  expect(pushes).toHaveLength(0);
  const held = await idb(page, "held");
  expect(held).toHaveLength(1);
  expect(held[0].sceneId).toBe(bigId);
  expect(textOf(held[0].doc)).toHaveLength(55_001);
  expect((await savedDoc(api, bigId)).revision).toBe(1);
  await ctx.close();
});
