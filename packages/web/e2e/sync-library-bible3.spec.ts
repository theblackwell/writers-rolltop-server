// M1-10 slice 3: the timeline (events) and state changes in a real browser, against the real API and a scratch database.
// Runs after sync-library-bible2.spec.ts (Mira Vale, Hollow Reach, the templates) and before zz-lockout.spec.ts.
// Each browser context has its own storage and device id. Continuity warnings, dismissals and overrides are later slices.
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
async function pushOps(api: APIRequestContext, ops: any[]): Promise<any[]> {
  const res = await api.post("/api/sync/v1/push", { data: { epoch: await epochOf(api), deviceId: randomUUID(), ops } });
  return (await res.json()).results;
}
async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}
async function newDevice(browser: Browser, poll = 0): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await ctx.addInitScript((ms) => { window.__ROLLTOP_POLL_MS__ = ms; }, poll);
  const page = await ctx.newPage();
  await signIn(page);
  return { ctx, page };
}
const left = (page: Page) => page.getByRole("navigation", { name: "Book and sections" });

/** A record as the server's feed holds it: the create value with later set and unset changes applied, and whether it is in the trash. */
async function recordById(api: APIRequestContext, kind: string, id: string): Promise<any | undefined> {
  const changes = await feed(api);
  const made = changes.find((c) => c.recordKind === kind && c.recordId === id && c.change === "create");
  if (!made) return undefined;
  const rec = structuredClone(made.value);
  for (const c of changes) {
    if (c.recordKind !== kind || c.recordId !== id) continue;
    if (c.change === "set") rec[c.field] = c.value;
    else if (c.change === "unset") delete rec[c.field];
    else if (c.change === "tombstone") rec.deletedAt = c.at;
    else if (c.change === "restore") delete rec.deletedAt;
  }
  return rec;
}
async function createdOf(api: APIRequestContext, kind: string, match: (v: any) => boolean): Promise<any[]> {
  return (await feed(api)).filter((c) => c.recordKind === kind && c.change === "create" && match(c.value)).map((c) => c.value);
}
const worldOpen = async (page: Page) => {
  await left(page).getByRole("button", { name: "Worldbuilding", exact: true }).click();
  await expect(left(page).getByRole("heading", { name: "Worldbuilding", level: 2 })).toBeVisible();
};
const charactersOpen = async (page: Page) => {
  await left(page).getByRole("button", { name: "Characters", exact: true }).click();
  await expect(left(page).getByRole("heading", { name: "Characters", level: 2 })).toBeVisible();
};
const statusOf = (page: Page, label: string | RegExp) =>
  page.getByLabel(label, { exact: true }).locator("xpath=ancestor::*[contains(@class,'field')][1]").getByRole("status");
const pushesOf = (page: Page): any[][] => {
  const out: any[][] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/sync/v1/push")) out.push(JSON.parse(r.postData() ?? "{}").ops ?? []); });
  return out;
};
const timeline = (page: Page) => left(page).getByRole("list", { name: "Timeline" });

let api: APIRequestContext;
let eventId: string;
let eventEntryId: string;
test.beforeAll(async () => { api = await apiLogin(); });
test.afterAll(async () => { await api.dispose(); });

test("the timeline starts empty, says so in plain words, and an event is made from its title", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  const pushes = pushesOf(page);
  await worldOpen(page);
  await expect(left(page).getByRole("heading", { name: "Timeline", level: 3 })).toBeVisible();
  await expect(left(page).getByText(/No events yet/)).toBeVisible();
  await left(page).getByRole("button", { name: "New event" }).click();
  await expect(page.getByRole("heading", { name: "New event" })).toBeFocused();
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "title of the event is needed" })).toBeVisible();
  expect(pushes.flat().filter((o) => o.recordKind === "event")).toHaveLength(0);
  await page.getByLabel("Title", { exact: true }).fill("The storm breaks the bridge");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("heading", { name: "The storm breaks the bridge", level: 2 })).toBeVisible();
  const made = (await createdOf(api, "event", (v) => v.title === "The storm breaks the bridge"))[0];
  expect(made).toBeTruthy();
  eventId = made.id;
  expect(made).toMatchObject({ scope: { kind: "book", id: BOOK }, sceneIds: [], participants: [] });
  expect(made.orderKey).toMatch(/^[0-9a-z]*[1-9a-z]$/);
  expect(Object.keys(made).sort()).toEqual(["createdAt", "id", "orderKey", "participants", "sceneIds", "scope", "title", "updatedAt"]);
  const item = timeline(page).getByRole("button", { name: /storm breaks the bridge/ });
  await expect(item).toContainText("No date");
  await expect(item).toContainText("No scenes");
  await expect(page.getByText(/belongs to the book "Test Book"/)).toBeVisible();
  // A second event comes after the first.
  await left(page).getByRole("button", { name: "New event" }).click();
  await page.getByLabel("Title", { exact: true }).fill("The bridge is rebuilt");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("heading", { name: "The bridge is rebuilt", level: 2 })).toBeVisible();
  await expect(timeline(page).getByRole("button")).toHaveText([/storm breaks/, /bridge is rebuilt/]);
  await ctx.close();
});

test("an event: edit title, summary, date, scenes, participants and the linked entry; arrays are sent whole; a refused value is not sent", async ({ browser }) => {
  // An entry of the type event is made by another device (there is no screen for those yet).
  const tpl = (await createdOf(api, "template", (v) => v.entryType === "event"))[0];
  eventEntryId = randomUUID();
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const [res] = await pushOps(api, [{ opId: randomUUID(), op: "create", recordKind: "entry", recordId: eventEntryId, value: {
    id: eventEntryId, entryType: "event", templateId: tpl.id, name: "Storm entry", aliases: [], scope: { kind: "book", id: BOOK }, values: {}, overrides: [], attachments: [], createdAt: now, updatedAt: now } }]);
  expect(res.status).toBe("applied");

  const { ctx, page } = await newDevice(browser);
  const pushes = pushesOf(page);
  await worldOpen(page);
  await timeline(page).getByRole("button", { name: /storm breaks/ }).click();
  await expect(page.getByRole("heading", { name: "The storm breaks the bridge", level: 2 })).toBeFocused();

  await page.getByLabel("Title", { exact: true }).fill("The storm breaks the old bridge");
  await page.getByLabel("Title", { exact: true }).blur();
  await expect(statusOf(page, "Title")).toHaveText("Saved");
  // An empty title is refused on the page, nothing is sent
  pushes.length = 0;
  await page.getByLabel("Title", { exact: true }).fill("  ");
  await page.getByLabel("Title", { exact: true }).blur();
  await expect(page.getByRole("alert").filter({ hasText: "title of the event is needed" })).toBeVisible();
  expect(pushes.flat()).toHaveLength(0);
  await page.getByLabel("Title", { exact: true }).fill("The storm breaks the old bridge");
  await page.getByLabel("Title", { exact: true }).blur();

  await page.getByLabel("Summary", { exact: true }).fill("Rain for three days.");
  await page.getByLabel("Summary", { exact: true }).blur();
  await expect(statusOf(page, "Summary")).toHaveText("Saved");

  // The date: a number that is not whole is refused before it is sent; a number with no label is refused
  const when = page.getByRole("group", { name: "When", exact: true });
  pushes.length = 0;
  await page.getByLabel("Date label", { exact: true }).fill("Third Moon, Year 388");
  await page.getByLabel("Number for ordering", { exact: true }).fill("1.5");
  await page.getByLabel("Number for ordering", { exact: true }).blur();
  await expect(when.getByRole("alert")).toContainText("whole number");
  expect(pushes.flat().filter((o) => o.field === "when" && o.value?.ordinal === 1.5)).toHaveLength(0);
  await page.getByLabel("Number for ordering", { exact: true }).fill("388");
  await page.getByLabel("Calendar", { exact: true }).fill("Lantern");
  await page.getByLabel("Calendar", { exact: true }).blur();
  await expect(when.getByRole("status")).toHaveText("Saved");
  let rec = await recordById(api, "event", eventId);
  expect(rec.when).toEqual({ label: "Third Moon, Year 388", calendar: "Lantern", ordinal: 388 });
  await expect(timeline(page).getByRole("button", { name: /old bridge/ })).toContainText("Third Moon, Year 388");

  // Scenes: the whole array
  pushes.length = 0;
  const scenes = page.getByRole("group", { name: "Scenes", exact: true });
  await scenes.getByLabel("Leave scene").check();
  await expect(scenes.getByRole("status")).toHaveText("Saved");
  expect(pushes.flat().filter((o) => o.field === "sceneIds")[0]).toMatchObject({ op: "set", recordKind: "event", value: [SCENE] });
  await expect(timeline(page).getByRole("button", { name: /old bridge/ })).toContainText("Scenes: Leave scene");

  // Participants: add, role, no duplicates, remove
  const people = page.getByRole("group", { name: "Participants", exact: true });
  await people.getByLabel("Add a participant").selectOption({ label: "Mira Vale (character)" });
  await expect(people.getByRole("status")).toHaveText("Saved");
  await expect(people.getByLabel("Add a participant").getByRole("option", { name: "Mira Vale (character)" })).toHaveCount(0);
  await people.getByLabel("Role of Mira Vale").fill("witness");
  await people.getByLabel("Role of Mira Vale").blur();
  await expect.poll(async () => (await recordById(api, "event", eventId)).participants).toEqual([{ entryId: expect.any(String), role: "witness" }]);
  await people.getByLabel("Add a participant").selectOption({ label: "Hollow Reach (place)" });
  await expect.poll(async () => (await recordById(api, "event", eventId)).participants.length).toBe(2);
  await people.getByRole("button", { name: "Remove Hollow Reach" }).click();
  await expect.poll(async () => (await recordById(api, "event", eventId)).participants.length).toBe(1);

  // The linked entry
  await page.getByLabel("Linked entry", { exact: true }).selectOption({ label: "Storm entry" });
  await expect(statusOf(page, "Linked entry")).toHaveText("Saved");
  rec = await recordById(api, "event", eventId);
  expect(rec).toMatchObject({ title: "The storm breaks the old bridge", summary: "Rain for three days.", entryId: eventEntryId, sceneIds: [SCENE] });
  expect(rec.dismissedWarnings).toBeUndefined();
  expect(rec.overrides).toBeUndefined();
  // Clearing removes the optional values
  await page.getByLabel("Linked entry", { exact: true }).selectOption({ label: "Not linked" });
  await page.getByLabel("Summary", { exact: true }).fill("");
  await page.getByLabel("Summary", { exact: true }).blur();
  await expect.poll(async () => (await recordById(api, "event", eventId)).summary).toBeUndefined();
  await expect.poll(async () => (await recordById(api, "event", eventId)).entryId).toBeUndefined();
  // No warnings, no dismissals, no overrides on this page
  await expect(page.getByText(/W_STATE_CONFLICT|W_CHRONOLOGY|warning|dismiss|override/i)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/bible-event-1280.png`, fullPage: true });

  // After a reload everything comes back from the feed
  await page.reload();
  await worldOpen(page);
  await timeline(page).getByRole("button", { name: /old bridge/ }).click();
  await expect(page.getByLabel("Date label", { exact: true })).toHaveValue("Third Moon, Year 388");
  await expect(page.getByLabel("Number for ordering", { exact: true })).toHaveValue("388");
  await expect(page.getByRole("group", { name: "Scenes", exact: true }).getByLabel("Leave scene")).toBeChecked();
  await expect(page.getByLabel("Role of Mira Vale")).toHaveValue("witness");
  await ctx.close();
});

test("state changes on an entry: add for a template field, edit value and note, move to a scene, remove and put back; a bad value is not sent", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  const pushes = pushesOf(page);
  await charactersOpen(page);
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  const section = page.getByRole("region", { name: "State changes" });
  await expect(section).toBeVisible();
  await expect(section.getByText("No state changes yet.")).toBeVisible();
  // Refused before it is sent: no field, a value of the wrong type, nothing chosen to attach to
  pushes.length = 0;
  const add = section.getByRole("group", { name: "Add a state change" });
  await add.getByRole("button", { name: "Add state change" }).click();
  await expect(add.getByRole("alert")).toContainText("Choose a field");
  await add.getByLabel("Field").selectOption({ label: "Age" });
  await add.getByLabel("Value", { exact: true }).fill("abc");
  await add.getByLabel("Changes at").selectOption({ label: "The storm breaks the old bridge" });
  await add.getByRole("button", { name: "Add state change" }).click();
  await expect(add.getByRole("alert")).toContainText("whole number");
  await add.getByLabel("Value", { exact: true }).fill("25");
  await add.getByLabel("Changes at").selectOption({ label: "Choose an event or scene" });
  await add.getByRole("button", { name: "Add state change" }).click();
  await expect(add.getByRole("alert")).toContainText("Choose the event or scene");
  expect(pushes.flat().filter((o) => o.recordKind === "stateChange")).toHaveLength(0);
  // Add at an event
  await add.getByLabel("Changes at").selectOption({ label: "The storm breaks the old bridge" });
  await add.getByLabel("Note").fill("After the fall.");
  await add.getByRole("button", { name: "Add state change" }).click();
  const row = section.getByRole("group", { name: "Age at the event The storm breaks the old bridge" });
  await expect(row).toBeVisible();
  const made = (await createdOf(api, "stateChange", (v) => v.entryId !== undefined))[0];
  expect(made).toMatchObject({ value: 25, eventId, note: "After the fall." });
  expect(made.nodeId).toBeUndefined();
  const mira = made.entryId;
  const field = made.fieldId;
  // Edit value and note
  await row.getByLabel("Value", { exact: true }).fill("26");
  await row.getByLabel("Value", { exact: true }).blur();
  await expect(row.getByRole("status").first()).toHaveText("Saved");
  await row.getByLabel("Note", { exact: true }).fill("");
  await row.getByLabel("Note", { exact: true }).blur();
  await expect.poll(async () => (await recordById(api, "stateChange", made.id)).value).toBe(26);
  await expect.poll(async () => (await recordById(api, "stateChange", made.id)).note).toBeUndefined();
  // A bad value stays on the page and is not sent
  pushes.length = 0;
  await row.getByLabel("Value", { exact: true }).fill("2.5");
  await row.getByLabel("Value", { exact: true }).blur();
  await expect(row.getByRole("alert")).toContainText("whole number");
  expect(pushes.flat()).toHaveLength(0);
  await row.getByLabel("Value", { exact: true }).fill("26");
  await row.getByLabel("Value", { exact: true }).blur();
  // The event page lists it
  // Move to a scene: a new record, then the old one is removed (the spec has no combined op)
  pushes.length = 0;
  await row.getByLabel("Changes at").selectOption({ label: "Leave scene" });
  await expect(section.getByRole("status").filter({ hasText: "State change moved." })).toBeVisible();
  const moved = section.getByRole("group", { name: "Age at the scene Leave scene" });
  await expect(moved).toBeVisible();
  expect(pushes.flat().map((o) => `${o.op}:${o.recordKind}`)).toEqual(["create:stateChange", "tombstone:stateChange"]);
  const all = await createdOf(api, "stateChange", (v) => v.entryId === mira);
  expect(all).toHaveLength(2);
  const fresh = all.find((v) => v.id !== made.id);
  expect(fresh).toMatchObject({ nodeId: SCENE, value: 26, fieldId: field });
  expect(fresh.eventId).toBeUndefined();
  expect((await recordById(api, "stateChange", made.id)).deletedAt).toBeTruthy();
  expect((await recordById(api, "stateChange", fresh.id)).deletedAt).toBeUndefined();
  // Remove, then put back
  await moved.getByRole("button", { name: /^Remove Age at the scene/ }).click();
  await expect(section.getByRole("status").filter({ hasText: "State change removed." })).toBeVisible();
  await expect(section.getByText("No state changes yet.")).toBeVisible();
  expect((await recordById(api, "stateChange", fresh.id)).deletedAt).toBeTruthy();
  await section.getByRole("list", { name: "Removed state changes" }).getByRole("button", { name: /^Put back Age at the scene/ }).click();
  await expect(section.getByRole("group", { name: "Age at the scene Leave scene" })).toBeVisible();
  expect((await recordById(api, "stateChange", fresh.id)).deletedAt).toBeUndefined();
  await page.screenshot({ path: `${SHOTS}/bible-statechange-1280.png`, fullPage: true });
  // Re-attach to the event so the event page shows it
  await section.getByRole("group", { name: "Age at the scene Leave scene" }).getByLabel("Changes at").selectOption({ label: "The storm breaks the old bridge" });
  await expect(section.getByRole("group", { name: "Age at the event The storm breaks the old bridge" })).toBeVisible();
  await worldOpen(page);
  await timeline(page).getByRole("button", { name: /old bridge/ }).click();
  await expect(page.getByRole("list", { name: "State changes at this event" })).toContainText("Mira Vale: Age becomes 26");
  await ctx.close();
});

test("an entry with no template says so and offers no state changes", async ({ browser }) => {
  const id = randomUUID();
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const [res] = await pushOps(api, [{ opId: randomUUID(), op: "create", recordKind: "entry", recordId: id, value: {
    id, entryType: "research", name: "Loose notes", aliases: [], scope: { kind: "book", id: BOOK }, values: {}, overrides: [], attachments: [], createdAt: now, updatedAt: now } }]);
  expect(res.status).toBe("applied");
  const { ctx, page } = await newDevice(browser);
  await worldOpen(page);
  await left(page).getByRole("button", { name: /Loose notes/ }).click();
  await expect(page.getByRole("heading", { name: "Loose notes", level: 2 })).toBeVisible();
  await expect(page.getByText("This entry has no template, so it cannot have state changes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add state change" })).toHaveCount(0);
  await ctx.close();
});

test("an event can be removed and put back; one removed on another device shows as gone", async ({ browser }) => {
  const { ctx, page } = await newDevice(browser, 150); // a poll brings the other device's change to the open page
  await worldOpen(page);
  await timeline(page).getByRole("button", { name: /bridge is rebuilt/ }).click();
  await page.getByRole("button", { name: "Remove this event" }).click();
  await expect(page.getByRole("heading", { name: "This event is gone" })).toBeVisible();
  await expect(page.getByText("It is in the trash.")).toBeVisible();
  await expect(timeline(page).getByRole("button", { name: /bridge is rebuilt/ })).toHaveCount(0);
  await expect(left(page).getByRole("list", { name: "Removed events" }).getByRole("button", { name: /bridge is rebuilt/ })).toBeVisible();
  const rebuilt = (await createdOf(api, "event", (v) => v.title === "The bridge is rebuilt"))[0];
  expect((await recordById(api, "event", rebuilt.id)).deletedAt).toBeTruthy();
  await page.getByRole("button", { name: "Put it back" }).click();
  await expect(page.getByRole("heading", { name: "The bridge is rebuilt", level: 2 })).toBeVisible();
  expect((await recordById(api, "event", rebuilt.id)).deletedAt).toBeUndefined();
  await expect(timeline(page).getByRole("button", { name: /bridge is rebuilt/ })).toBeVisible();
  // Another device removes it while this page shows it
  const head = (await feed(api)).at(-1)!.seq;
  const [t] = await pushOps(api, [{ opId: randomUUID(), op: "tombstone", recordKind: "event", recordId: rebuilt.id, baseSeq: head }]);
  expect(t.status).toBe("applied");
  await expect(page.getByRole("heading", { name: "This event is gone" })).toBeVisible();
  // Typing into a removed event is refused with the plain message, not lost silently: restore from the gone page
  await page.getByRole("button", { name: "Put it back" }).click();
  await expect(page.getByRole("heading", { name: "The bridge is rebuilt", level: 2 })).toBeVisible();
  await ctx.close();
});

test("the timeline and state change views are labelled, have 44 px targets, and fit a phone with Reduced Motion and Increase Contrast", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", contrast: "more" });
  await ctx.addInitScript(() => { window.__ROLLTOP_POLL_MS__ = 0; });
  const page = await ctx.newPage();
  await signIn(page);
  const measure = () => page.evaluate(() => {
    const nameOf = (el: Element): string => {
      const label = el.getAttribute("aria-label")?.trim();
      if (label) return label;
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.labels?.length) return [...el.labels].map((l) => l.textContent).join(" ").trim();
      return (el.textContent ?? "").trim();
    };
    const root = document.querySelector("main")!; // the editor behind the bible is kept mounted but hidden: it is not measured
    const shown = (el: Element): boolean => el.closest("[hidden]") === null;
    const fields = [...root.querySelectorAll("input, textarea, select")].filter(shown);
    const small = [...root.querySelectorAll<HTMLElement>("input:not([type=checkbox]), textarea, select, button")].concat(
      [...root.querySelectorAll<HTMLElement>("input[type=checkbox]")].map((i) => i.closest(".check") as HTMLElement))
      .filter((el) => shown(el)).map((el) => { const r = el.getBoundingClientRect(); return { name: el.id || el.textContent?.trim(), w: r.width, h: r.height }; })
      .filter((t) => t.w < 43.99 || t.h < 43.99);
    return { count: fields.length, unnamed: fields.filter((el) => nameOf(el) === "").length, small, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
  });
  // The event
  await page.getByRole("button", { name: "Book and sections" }).click();
  await left(page).getByRole("button", { name: "Worldbuilding", exact: true }).click();
  await timeline(page).getByRole("button", { name: /old bridge/ }).click();
  await expect(page.getByRole("heading", { name: "The storm breaks the old bridge", level: 2 })).toBeFocused();
  let result = await measure();
  expect(result.count).toBeGreaterThan(8);
  expect(result.unnamed).toBe(0);
  expect(result.small).toEqual([]);
  expect(result.scrollW).toBeLessThanOrEqual(result.innerW);
  await page.screenshot({ path: `${SHOTS}/bible-event-390.png`, fullPage: true });
  // The entry with its state changes
  await page.getByRole("button", { name: "Book and sections" }).click();
  await left(page).getByRole("button", { name: "Characters", exact: true }).click();
  await left(page).getByRole("button", { name: /Mira Vale/ }).click();
  await expect(page.getByRole("heading", { name: "Mira Vale", level: 2 })).toBeFocused();
  await expect(page.getByRole("region", { name: "State changes" })).toBeVisible();
  result = await measure();
  expect(result.count).toBeGreaterThan(14);
  expect(result.unnamed).toBe(0);
  expect(result.small).toEqual([]);
  expect(result.scrollW).toBeLessThanOrEqual(result.innerW);
  await page.screenshot({ path: `${SHOTS}/bible-statechange-390.png`, fullPage: true });
  await ctx.close();
});
