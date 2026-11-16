import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { test as base, expect } from "@playwright/test";

if (!process.env.E2E_FIXTURE) throw new Error("Use npm run e2e so the scratch launcher owns the server");
export const fixture = JSON.parse(readFileSync(process.env.E2E_FIXTURE, "utf8"));
if (new URL(fixture.url).port === "38886" || !fixture.env.BB_DATA_DIR.startsWith("/tmp/bb-sidebar-smoke-")) {
  throw new Error("E2E fixture must target a scratch server");
}

for (const key of [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "TMPDIR",
]) {
  if (!fixture.env[key]?.startsWith(`${fixture.env.BB_DATA_DIR}/`))
    throw new Error(`CLI ${key} must be inside scratch`);
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /\[plugin:bb-sidebar\]|is not a function|ReferenceError|TypeError/.test(message.text())
      ) {
        errors.push(message.text());
      }
    });
    await use(page);
    expect(errors, "sidebar/browser JavaScript errors").toEqual([]);
  },
});

export async function cli(args) {
  const { stdout } = await promisify(execFile)(fixture.bb, [...args, "--json"], {
    env: fixture.env,
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

export async function rpc(request, method, input = {}) {
  const response = await request.post(`${fixture.url}/api/v1/plugins/bb-sidebar/rpc/${method}`, { data: input });
  expect(response.ok(), `RPC ${method}: ${await response.text()}`).toBe(true);
  const payload = await response.json();
  expect(payload.ok, `RPC ${method} failed`).toBe(true);
  return payload.result;
}

export function shelf(page, name) {
  return page.getByRole("region", { name, exact: true });
}

export function link(page, title, name = "Active") {
  return shelf(page, name).getByRole("link", { name: new RegExp(`${title}$`) });
}

export async function menu(page, title, name = "Active") {
  await link(page, title, name).click({ button: "right" });
  return page.getByRole("menu", { name: "Thread actions", exact: true });
}

export async function expand(page, name) {
  const header = shelf(page, name).getByRole("button", { name: new RegExp(`^${name}`) });
  if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
}

export async function reset(request) {
  await rpc(request, "updateSidebarSettings", fixture.defaultSettings);
  for (const thread of fixture.threads) {
    await cli(["thread", "unpin", thread.id]);
    await cli(["thread", "read", thread.id]);
    await rpc(request, "unsnooze", { threadId: thread.id });
    await rpc(request, "unsettle", { threadId: thread.id });
  }
  await rpc(request, "reorderInbox", { inboxThreadIds: fixture.threads.map(({ id }) => id) });
}

export async function open(page, { theme = "light", width = 320, empty = false } = {}) {
  await page.addInitScript(
    ({ theme, width }) => {
      localStorage.setItem("bb.theme", theme);
      // bb 0.47.0 reserves 49 px for its navigation rail and border.
      localStorage.setItem("bb.sidebar.width", String(width + 49));
    },
    { theme, width },
  );
  await page.goto(fixture.url);
  if (empty) {
    await expect(page.getByText("All clear. Time to touch some grass.")).toBeVisible();
  } else {
    await expect(shelf(page, "Active")).toBeVisible();
  }
}

// bb keeps a scrollbar lane in its sidebar content (0 px with overlay scrollbars).
export async function expectSidebarWidth(page, width) {
  const { content, lane, root } = await page.evaluate(() => {
    const root = document.querySelector("[data-bb-sidebar-root]");
    const content = root.closest('[data-sidebar="content"]');
    return {
      content: content.offsetWidth,
      lane: content.offsetWidth - content.clientWidth,
      root: root.getBoundingClientRect().width,
    };
  });
  expect(content).toBe(width);
  expect(Math.round(root)).toBe(width - lane);
}
