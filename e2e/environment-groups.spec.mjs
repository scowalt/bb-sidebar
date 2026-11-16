import { mkdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { seededTest as test } from "./seeds.mjs";
import { fixture, cli, rpc, reset, open, shelf, expectSidebarWidth } from "./helpers.mjs";

for (const [name, theme, width] of [
  ["dark", "dark", 320],
  ["light", "light", 320],
  ["narrow", "dark", 280],
]) {
  test(`environment groups in the actual sidebar: ${name}`, async ({ page, request, worktrees }) => {
    await reset(request);
    const [atlas, birch, cedar, delta] = fixture.threads;
    await cli(["thread", "pin", atlas.id]);
    await rpc(request, "park", { threadId: birch.id });
    await rpc(request, "snooze", { threadId: cedar.id, snoozedUntil: Date.now() + 86_400_000 });
    await rpc(request, "settle", { threadId: delta.id });
    await rpc(request, "reorderInbox", { inboxThreadIds: worktrees.map(({ id }) => id) });
    await open(page, { theme, width });
    await page.getByRole("button", { name: "Sort active threads: Manual order" }).click();
    await expect(page.getByRole("checkbox", { name: "Group by worktree" })).toHaveCount(0);
    await page.getByRole("dialog", { name: "Sort active threads" }).getByText("Project", { exact: true }).click();
    const toggle = page.getByRole("checkbox", { name: "Group by worktree" });
    await expect(toggle).not.toBeChecked();
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    const search = page.getByRole("region", { name: "feature/search worktree", exact: true });
    await expect(search.getByRole("link")).toHaveCount(2);
    await expect(page.getByRole("region", { name: "fix/menus worktree", exact: true }).getByRole("link")).toHaveCount(
      2,
    );
    await expect(shelf(page, "Pinned").getByRole("region")).toHaveCount(0);
    mkdirSync("e2e-artifacts", { recursive: true });
    const sidebar = page.locator("[data-bb-sidebar-root]");
    await page.addStyleTag({ path: "e2e/snapshot.css" });
    await page.mouse.move(1000, 750);
    await expectSidebarWidth(page, width);
    await sidebar.screenshot({ path: `e2e-artifacts/environment-picker-${name}.png`, animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveCount(0);
    await sidebar.screenshot({ path: `e2e-artifacts/environment-groups-${name}.png`, animations: "disabled" });
    await page.getByRole("button", { name: "feature/search (2)", exact: true }).click();
    await expect(search.getByRole("link")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "feature/search (2)", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page.getByRole("button", { name: "feature/search (2)", exact: true }).click();
    await page.getByRole("button", { name: "Sort active threads: Project" }).click();
    await expect(toggle).toBeChecked();
    await page
      .getByRole("dialog", { name: "Sort active threads" })
      .getByText("Group by worktree", { exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(shelf(page, "Active").getByRole("link")).toHaveCount(4);
  });
}
