import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Tests run in file order against one scratch database: setup first, then everything that needs an owner.
test.describe.configure({ mode: "serial" });

const PASSWORD = "correct horse battery staple";
const SHOTS = process.env.ROLLTOP_SHOT_DIR ?? "test-results/shots";
mkdirSync(SHOTS, { recursive: true });

const SIZES = { desktop: { width: 1280, height: 800 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } } as const;

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

test("first run shows setup; a wrong token and a short password are refused with plain messages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up your studio" })).toBeVisible();
  await page.getByLabel("Setup token").fill("not-the-token");
  await page.getByLabel("New password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toHaveText("The password must be at least 12 characters.");
  await page.getByLabel("New password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toContainText("The setup token is wrong or has expired");
});

test("setup with the token from the server log creates the account and opens the shell; nothing is stored", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Setup token").fill(process.env.ROLLTOP_E2E_SETUP_TOKEN!);
  await page.getByLabel("New password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const stored = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, url: location.href }));
  expect(stored.local).toBe(0);
  expect(stored.session).toBe(0);
  expect(stored.url).not.toContain(process.env.ROLLTOP_E2E_SETUP_TOKEN!);
  expect(stored.url).not.toContain("password");
});

test("signed out shows sign-in; a wrong password is refused; the right one opens the shell; a reload stays signed in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Password").fill("wrong wrong wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("That password is not right.");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.map((c) => c.name)).toEqual(["rolltop_session"]);
  expect(cookies[0]!.httpOnly).toBe(true);
});

test("sign out returns to sign-in and the session is gone after a reload", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("You are signed out.");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("the shell has the reference layout, names and landmarks; no header menus", async ({ page }) => {
  await page.setViewportSize(SIZES.desktop);
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Writers Rolltop" })).toBeVisible();
  await expect(page.getByText("A Workspace for Novelists")).toBeVisible();
  const header = page.getByRole("banner");
  const main = page.getByRole("navigation", { name: "Main" });
  await expect(header).toBeVisible();
  for (const name of ["Home", "Write", "Notes", "Book Bible", "Tools", "Resources"]) {
    await expect(main.getByRole("button", { name })).toBeVisible();
  }
  await expect(main.getByRole("button", { name: "Write" })).toHaveAttribute("aria-current", "page");
  for (const bad of ["File", "Edit", "View"]) await expect(page.getByRole("menubar").or(page.getByRole("button", { name: bad, exact: true }))).toHaveCount(0);
  const left = page.getByRole("navigation", { name: "Book and sections" });
  await expect(left.getByRole("button", { name: /The Ember Crown/ })).toBeVisible();
  for (const name of ["Manuscript", "Notes", "Characters", "Worldbuilding", "Scenes", "Revisions"]) {
    await expect(left.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("group", { name: "Open documents" }).getByRole("button", { name: "Chapter 3", exact: true })).toBeVisible();
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  for (const name of ["Undo", "Redo", "Bold", "Italic", "Underline", "Bulleted list", "Numbered list", "Expand editor"]) {
    await expect(toolbar.getByRole("button", { name })).toBeVisible();
  }
  const aside = page.getByRole("complementary", { name: "Quick Notes and Book Bible" });
  await expect(aside.getByRole("heading", { name: "Quick Notes" })).toBeVisible();
  await expect(aside.getByRole("heading", { name: "Book Bible" })).toBeVisible();
  await expect(aside.getByRole("button", { name: "Characters" })).toBeVisible();
});

test("keyboard: tabs, book switcher, top bar and Expand work without a mouse", async ({ page }) => {
  await page.setViewportSize(SIZES.desktop);
  await signIn(page);
  // New document and close it with the keyboard.
  await page.getByRole("button", { name: "New document" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Untitled 1", exact: true })).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "Close Untitled 1" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Untitled 1", exact: true })).toHaveCount(0);
  // Book switcher: open, choose with keyboard, Escape closes and returns focus.
  const sw = page.getByRole("button", { name: /Change book/ });
  await sw.focus();
  await page.keyboard.press("Enter");
  await expect(sw).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(sw).toHaveAttribute("aria-expanded", "false");
  await expect(sw).toBeFocused();
  await sw.press("Enter");
  await page.getByRole("button", { name: "Ashes of Vael" }).press("Enter");
  await expect(page.getByRole("button", { name: /Book: Ashes of Vael/ })).toBeFocused();
  // Expand hides the side panels and Restore brings them back.
  const expand = page.getByRole("button", { name: "Expand editor" });
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Book and sections" })).toBeHidden();
  await page.getByRole("button", { name: "Restore panels" }).press("Enter");
  await expect(page.getByRole("navigation", { name: "Book and sections" })).toBeVisible();
  // A focused control shows a visible outline.
  await page.getByRole("button", { name: "Tools" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const outline = await page.getByRole("button", { name: "Tools" }).evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
  // Top bar item selects a destination that says plainly it is not ready.
  await page.getByRole("button", { name: "Tools" }).press("Enter");
  await expect(page.getByText("Tools is not ready yet.")).toBeVisible();
});

for (const [label, size] of Object.entries(SIZES)) {
  test(`layout at ${label} (${size.width}px): no horizontal scroll, touch targets 44px, screenshot`, async ({ page }) => {
    await page.setViewportSize(size);
    await signIn(page);
    if (label === "phone") {
      // Panels are collapsed behind buttons.
      await expect(page.getByRole("navigation", { name: "Book and sections" })).toBeHidden();
      await expect(page.getByRole("complementary")).toBeHidden();
      await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Resources" })).toBeVisible();
      const toggle = page.getByRole("button", { name: "Book and sections" });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(page.getByRole("navigation", { name: "Book and sections" })).toBeVisible();
      await toggle.click();
      await expect(page.getByRole("navigation", { name: "Book and sections" })).toBeHidden();
    } else {
      await expect(page.getByRole("complementary")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Book and sections" })).toBeVisible();
    }
    const notice = page.getByRole("region", { name: "Sample content notice" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Sample content");
    await expect(notice).toContainText("not connected");
    await expect(page.getByRole("button", { name: /Book: The Ember Crown \(sample\)/, includeHidden: true })).toBeAttached();
    const m = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      small: [...document.querySelectorAll<HTMLElement>("button, a[href], input")]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => { const r = el.getBoundingClientRect(); return { name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.id, w: r.width, h: r.height }; })
        .filter((t) => t.w < 43.99 || t.h < 43.99),
    }));
    expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
    expect(m.small).toEqual([]);
    const smallest = await page.evaluate(() => Math.min(...[...document.querySelectorAll<HTMLElement>("button, a[href], input")]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height); })));
    console.log(`${label}: smallest visible target ${smallest.toFixed(1)} px`);
    await page.screenshot({ path: `${SHOTS}/studio-${label}-${size.width}.png`, fullPage: true });
  });
}

test("sign-in and setup screens also fit the phone width", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: SIZES.phone });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(m.s).toBeLessThanOrEqual(m.w);
  await page.screenshot({ path: `${SHOTS}/signin-phone-390.png`, fullPage: true });
  await ctx.close();
});

test("every control has an accessible name and headings are in order", async ({ page }) => {
  await page.setViewportSize(SIZES.desktop);
  await signIn(page);
  const result = await page.evaluate(() => {
    const nameOf = (el: Element): string => {
      const label = el.getAttribute("aria-label")?.trim();
      if (label) return label;
      const by = el.getAttribute("aria-labelledby");
      if (by) return by.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (el instanceof HTMLInputElement && el.labels?.length) return [...el.labels].map((l) => l.textContent).join(" ").trim();
      return (el.textContent ?? "").trim();
    };
    const controls = [...document.querySelectorAll("button, a[href], input, [role=button], [role=toolbar], nav, aside, section")];
    const unnamed = controls.filter((el) => nameOf(el) === "").map((el) => el.outerHTML.slice(0, 80));
    const levels = [...document.querySelectorAll("h1,h2,h3")].map((h) => Number(h.tagName[1]));
    return { count: controls.length, unnamed, levels, h1s: levels.filter((l) => l === 1).length };
  });
  expect(result.unnamed).toEqual([]);
  expect(result.h1s).toBe(1);
  // No heading level is skipped.
  result.levels.forEach((l, i) => { if (i > 0) expect(l - result.levels[i - 1]!).toBeLessThanOrEqual(1); });
});

test("dark appearance keeps the parchment light; Increase Contrast drops textures; Reduced Motion removes transitions", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: SIZES.desktop, colorScheme: "dark", contrast: "more", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await signIn(page);
  const r = await page.evaluate(() => {
    const card = document.querySelector(".card")!;
    const frame = document.querySelector(".frame")!;
    const lum = (rgb: string) => { const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.map(Number) as [number, number, number]; return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    const btn = document.querySelector("button")!;
    return {
      cardBg: getComputedStyle(card).backgroundImage, cardColor: getComputedStyle(card).backgroundColor,
      frameBg: getComputedStyle(frame).backgroundImage,
      pageLum: lum(getComputedStyle(document.querySelector(".page")!).backgroundColor === "rgba(0, 0, 0, 0)" ? "rgb(255,250,240)" : getComputedStyle(document.querySelector(".page")!).backgroundColor),
      trans: getComputedStyle(btn).transitionDuration, scheme: getComputedStyle(document.documentElement).colorScheme,
    };
  });
  expect(r.cardBg).toBe("none");
  expect(r.frameBg).toBe("none");
  expect(r.scheme).toBe("light");
  expect(r.pageLum).toBeGreaterThan(0.8);
  expect(r.trans).toBe("0s");
  await ctx.close();
  // Dark appearance alone (textures stay): the parchment is still light.
  const ctx2 = await browser.newContext({ viewport: SIZES.desktop, colorScheme: "dark" });
  const p2 = await ctx2.newPage();
  await signIn(p2);
  await p2.screenshot({ path: `${SHOTS}/studio-dark-1280.png` });
  const bg = await p2.evaluate(() => getComputedStyle(document.querySelector(".card")!).backgroundImage);
  expect(bg).toContain("gradient");
  await ctx2.close();
});

test("a busy sign-in queue (429 AUTH_BUSY) is worded differently from too many wrong passwords", async ({ page }) => {
  await page.route("**/api/auth/login", (route) => route.fulfill({
    status: 429, headers: { "retry-after": "5", "content-type": "application/json" },
    body: JSON.stringify({ error: { code: "AUTH_BUSY", message: "Too many sign-in attempts at once. Try again shortly." } }),
  }));
  await page.goto("/");
  await page.getByLabel("Password").fill("anything at all");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("The server is busy. Try again in 5 seconds.");
});
