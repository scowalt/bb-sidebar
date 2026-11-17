import { expect } from "@playwright/test";
import { test, fixture, rpc, link, reset, open } from "./helpers.mjs";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("rows on screen get their threads scanned for pull requests", async ({ page, request }) => {
  test.setTimeout(60_000);
  const keys = fixture.threads.map(({ id }) => id);
  await open(page);
  for (const thread of fixture.threads) await expect(link(page, thread.title)).toBeVisible();
  await expect
    .poll(
      async () => {
        const rows = await rpc(request, "getPullRequests", { keys });
        return keys.map((key) => rows[key].scanned);
      },
      { timeout: 30_000 },
    )
    .toEqual(keys.map(() => true));
  const rows = await rpc(request, "getPullRequests", { keys });
  for (const key of keys) expect(rows[key].entries).toEqual([]);
});
