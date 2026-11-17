// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { renderSlot } from "./test-slot";
import { deferred, inbox, thread, listProps, loadInboxApp, stubIntersectionObservers } from "./test-inbox";
import type { PullRequestEntry, PullRequestFacts, ThreadPullRequests } from "./pull-request-status";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    title: "Fix the flake",
    state: "open",
    draft: false,
    mergeable: true,
    checks: { total: 3, passed: 3, pending: 0, failing: [] },
    review: null,
    head: "feature",
    base: "main",
    mergedAt: null,
    additions: 10,
    deletions: 2,
    ...overrides,
  };
}
function entry(number: number, value: Partial<PullRequestFacts> | null = {}, repo = "o/r"): PullRequestEntry {
  return { url: `https://git.example.com/${repo}/pulls/${number}`, repo, number, facts: value && facts(value) };
}
const merged = (number: number, mergedAt: string) =>
  entry(number, { state: "merged", mergedAt, title: `Merged ${number}` });
const failing = { checks: { total: 19, passed: 18, pending: 0, failing: ["PR Format / format (pull_request)"] } };
const running = { checks: { total: 19, passed: 16, pending: 3, failing: [] } };

type Row = { threadId: string; settledAt: number | null; snoozedUntil: number | null; snoozedAt: number | null };

function mount({
  rows = {},
  lifecycle = [],
  threads = [thread({ id: "thr_pr", title: "PR thread" })],
  lifecycleGate,
}: {
  rows?: Record<string, ThreadPullRequests>;
  lifecycle?: Row[];
  threads?: PluginSidebarThread[];
  lifecycleGate?: Promise<void>;
} = {}) {
  const requested: string[][] = [];
  const view = renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads,
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: {
      listLifecycle: async () => {
        await lifecycleGate;
        return { rows: lifecycle };
      },
      getPullRequests: (input) => {
        const { keys } = input as { keys: string[] };
        requested.push(keys);
        return Object.fromEntries(
          keys.map((key) => [key, rows[key] ?? { entries: [], scanned: true, scanFailed: false }]),
        );
      },
    },
  });
  return { view, requested };
}

const rail = (name: string | RegExp = /^Pull requests:/) => screen.findByRole("img", { name });
const segments = (element: HTMLElement) =>
  [...element.querySelectorAll<HTMLElement>("[data-status]")].map((segment) => segment.dataset.status);

describe("pull request rail", () => {
  it("draws one segment per PR in progress order, and the count in the worst open tone", async () => {
    mount({
      rows: {
        thr_pr: {
          scanned: true,
          scanFailed: false,
          entries: [
            entry(3, failing),
            merged(1, "2026-11-02T00:00:00Z"),
            entry(2, running),
            entry(4, { state: "closed" }),
          ],
        },
      },
    });
    // Merged first, then open work by number, then closed: progress, not urgency.
    const bar = await rail("Pull requests: 1 of 4 merged, 1 failing, 1 running");
    expect(segments(bar)).toEqual(["merged", "checks_pending", "checks_failed", "closed"]);
    const pending = bar.querySelector('[data-status="checks_pending"]')!;
    expect(pending.className).toContain("bb-sidebar-working-pulse");
    expect(bar.querySelector('[data-status="checks_failed"]')!.className).toContain("bb-sidebar-pr-alert");
    expect(bar.className).toContain("pointer-events-none");
    expect(bar.className).toContain("absolute");
    const count = screen.getByText("1/4");
    expect(count.className).toContain("text-[color:var(--bb-sidebar-pr-alert)]");
    expect(screen.queryByRole("link", { name: /^#/ })).toBeNull();
    fireEvent.pointerMove(count);
    fireEvent.focus(count);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      [
        "#1 Merged: Merged 1",
        "#2 Checks running: Fix the flake",
        "#3 Checks failed: Fix the flake",
        "#4 Closed: Fix the flake",
      ].join("\n"),
    );
  });

  it("links a single PR by number, with its title and status in the tooltip", async () => {
    mount({
      rows: { thr_pr: { scanned: true, scanFailed: false, entries: [entry(412, { review: "review_requested" })] } },
    });
    const badge = await screen.findByRole("link", { name: "#412" });
    expect(badge.getAttribute("href")).toBe("https://git.example.com/o/r/pulls/412");
    expect(badge.className).toContain("text-[color:var(--bb-sidebar-pr-review)]");
    fireEvent.focus(badge);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Fix the flake\nAwaiting review");
    expect(segments(await rail("Pull requests: 0 of 1 merged, 1 in review"))).toEqual(["review_requested"]);
  });

  it("forwards a click on the count to the row link with its modifiers, so Cmd-click still splits", async () => {
    mount({ rows: { thr_pr: { scanned: true, scanFailed: false, entries: [entry(1), entry(2)] } } });
    const count = await screen.findByText("0/2");
    const link = screen.getByRole("link", { name: "PR thread" });
    const clicks: Array<{ metaKey: boolean; ctrlKey: boolean }> = [];
    link.addEventListener("click", (event) => {
      event.preventDefault();
      clicks.push({ metaKey: event.metaKey, ctrlKey: event.ctrlKey });
    });
    fireEvent.click(count, { metaKey: true });
    fireEvent.click(count, { ctrlKey: true });
    fireEvent.click(count);
    expect(clicks).toEqual([
      { metaKey: true, ctrlKey: false },
      { metaKey: false, ctrlKey: true },
      { metaKey: false, ctrlKey: false },
    ]);
  });

  it("colors the count violet once everything is merged", async () => {
    mount({
      rows: {
        thr_pr: {
          scanned: true,
          scanFailed: false,
          entries: [merged(1, "2026-11-01T00:00:00Z"), merged(2, "2026-11-02T00:00:00Z")],
        },
      },
    });
    expect((await screen.findByText("2/2")).className).toContain("text-[color:var(--bb-sidebar-pr-merged)]");
  });

  it("shows nothing for a thread without pull requests", async () => {
    const { requested } = mount();
    await screen.findByText("PR thread");
    await waitFor(() => expect(requested).toEqual([["thr_pr"]]));
    expect(screen.queryByRole("img", { name: /^Pull requests/ })).toBeNull();
    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
  });

  it("requests a row's key only while the row is on screen", async () => {
    const { observers, notify } = stubIntersectionObservers();
    const row = () => screen.getByRole("link", { name: "PR thread" }).closest("li")!;
    try {
      const { requested } = mount({ rows: { thr_pr: { scanned: true, scanFailed: false, entries: [entry(7)] } } });
      await waitFor(() => expect(observers.has(row())).toBe(true));
      await act(async () => {});
      expect(requested).toEqual([]);
      await waitFor(async () => {
        await act(async () => notify(row(), true));
        expect(screen.getByRole("link", { name: "#7" })).toBeTruthy();
      });
      expect(requested).toEqual([["thr_pr"]]);
      await act(async () => notify(row(), false));
      expect(screen.queryByRole("link", { name: "#7" })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requests nothing before the lifecycle rows have loaded", async () => {
    const gate = deferred<void>();
    const { requested } = mount({
      rows: { thr_pr: { scanned: true, scanFailed: false, entries: [entry(7)] } },
      lifecycleGate: gate.promise,
    });
    await screen.findByText("PR thread");
    await act(async () => {});
    expect(requested).toEqual([]);
    gate.resolve();
    await screen.findByRole("link", { name: "#7" });
    expect(requested).toEqual([["thr_pr"]]);
  });

  it("draws the rail on compact and shelved live rows, without a count", async () => {
    const { requested } = mount({
      threads: [thread({ id: "thr_parked", title: "Parked work" })],
      lifecycle: [],
      rows: { thr_parked: { scanned: true, scanFailed: false, entries: [entry(1), entry(2, failing)] } },
    });
    await screen.findByRole("img", { name: "Pull requests: 0 of 2 merged, 1 failing, 1 ready" });
    expect(requested).toEqual([["thr_parked"]]);
  });

  it("never asks about a settled row, and asks once while its hover card is open", async () => {
    const { requested } = mount({
      threads: [thread({ id: "thr_done", title: "Done work" })],
      lifecycle: [{ threadId: "thr_done", settledAt: 200, snoozedUntil: null, snoozedAt: null }],
      rows: {
        thr_done: {
          scanned: true,
          scanFailed: false,
          entries: [merged(1, "2026-11-01T00:00:00Z"), merged(2, "2026-11-02T00:00:00Z")],
        },
      },
    });
    const settled = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(settled).getByRole("button", { name: /^Settled/ }));
    const link = await within(settled).findByRole("link", { name: /Done work$/ });
    await act(async () => {});
    expect(requested).toEqual([]);
    expect(within(settled).queryByRole("img", { name: /^Pull requests/ })).toBeNull();
    act(() => link.focus());
    const card = await screen.findByRole("dialog", { name: "Thread details" });
    await within(card).findByText("2 of 2 merged");
    expect(requested).toEqual([["thr_done"]]);
    fireEvent.keyDown(link, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
    expect(requested).toEqual([["thr_done"]]);
  });
});

describe("pull requests in the hover card", () => {
  async function openCard(rows: ThreadPullRequests) {
    const result = mount({ rows: { thr_pr: rows } });
    const link = await screen.findByRole("link", { name: "PR thread" });
    act(() => link.focus());
    const card = await screen.findByRole("dialog", { name: "Thread details" });
    return { ...result, card };
  }

  it("lists open work first as stacks, folds finished PRs, and spells out checks", async () => {
    const { card } = await openCard({
      scanned: true,
      scanFailed: false,
      entries: [
        merged(1, "2026-11-01T00:00:00Z"),
        merged(2, "2026-11-02T00:00:00Z"),
        entry(3, { state: "closed" }),
        entry(10, { head: "a", base: "main", ...running, title: "Root" }),
        entry(11, { head: "b", base: "a", ...failing, mergeable: false, title: "Child" }),
        entry(12, { head: "c", base: "main", title: "Other root", review: "review_requested" }),
      ],
    });
    expect(within(card).getByText("2 of 6 merged")).toBeTruthy();
    expect(within(card).getByText("1 failing")).toBeTruthy();
    expect(within(card).getByText("1 running")).toBeTruthy();
    const list = within(card).getByRole("list", { name: "Pull requests" });
    const refs = () =>
      within(list)
        .getAllByRole("link")
        .map((item) => item.textContent);
    expect(refs()).toEqual(["#10", "#11", "#12"]);
    expect([...list.querySelectorAll<HTMLElement>("li[data-depth]")].map((item) => item.dataset.depth)).toEqual([
      "0",
      "1",
      "0",
    ]);
    expect(within(list).getByText("PR Format / format failed").className).toContain("bb-sidebar-pr-alert");
    expect(within(list).getByText("conflicts")).toBeTruthy();
    expect(within(list).getByText("3 of 19 checks running")).toBeTruthy();
    expect(within(list).getByText("Awaiting review")).toBeTruthy();
    expect(within(list).getAllByText("+10")).toHaveLength(3);
    fireEvent.click(within(card).getByRole("button", { name: "Show 2 merged, 1 closed" }));
    expect(refs()).toEqual(["#10", "#11", "#12", "#2", "#1", "#3"]);
    expect(within(list).getByText("closed")).toBeTruthy();
    expect(within(list).getAllByText(/^merged \d+d ago$/)).toHaveLength(2);
  });

  it("says it is looking while the thread's log has not been scanned", async () => {
    const { card } = await openCard({ scanned: false, scanFailed: false, entries: [] });
    expect(within(card).getByText("Looking for pull requests…")).toBeTruthy();
  });

  it("stops saying it is looking once the scan has failed", async () => {
    const { card } = await openCard({ scanned: false, scanFailed: true, entries: [] });
    expect(within(card).getByText("Couldn't look for pull requests")).toBeTruthy();
    expect(within(card).queryByText("Looking for pull requests…")).toBeNull();
  });

  it("names the repo when the thread's PRs span several", async () => {
    const { card } = await openCard({
      scanned: true,
      scanFailed: false,
      entries: [entry(1, {}, "acme/internal-tool-csm-ops"), entry(2, {}, "acme/backend-net")],
    });
    const list = within(card).getByRole("list", { name: "Pull requests" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((item) => item.textContent),
    ).toEqual(["csm-ops#1", "backend-net#2"]);
  });
});
