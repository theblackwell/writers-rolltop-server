import { expect, test } from "@playwright/test";

// Runs last (files run in name order, one worker): it locks sign-in for this scratch database, so no later test could sign in.

test("too many wrong passwords shows the wait time (last: it locks sign-in for this scratch database)", async ({ page }) => {
  await page.goto("/");
  for (let i = 0; i < 5; i++) {
    await page.getByLabel("Password").fill(`wrong password ${i}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("That password is not right.");
  }
  await page.getByLabel("Password").fill("wrong password again");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(/Too many wrong passwords\. Wait (\d+ minutes|1 minute), then try again\./);
});
