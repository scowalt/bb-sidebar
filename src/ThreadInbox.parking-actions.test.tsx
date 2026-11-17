// @vitest-environment jsdom
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import {
  inbox,
  SETTLED_NOTHING,
  thread,
  listProps,
  statusSlotParts,
  nestedInteractiveControls,
  loadInboxApp,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("parking threads", () => {
  it("snoozes to a picked date and time from the snooze menu", async () => {
    const snooze = vi.fn(() => ({ ok: true }));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_pick", title: "Later work" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }), snooze },
    });

    fireEvent.keyDown(await screen.findByRole("combobox", { name: "Snooze thread" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Pick date & time…" }));
    const dialog = await screen.findByRole("dialog", { name: "Snooze until" });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(within(dialog).getByText(/^Wakes /)).toBeDefined();

    const time = within(dialog).getByLabelText("Time");
    fireEvent.change(time, { target: { value: "" } });
    expect(within(dialog).getByText("Enter a time.")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Snooze" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(time, { target: { value: "16:45" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Snooze" }));
    await waitFor(() =>
      expect(snooze).toHaveBeenCalledWith({
        threadId: "thr_pick",
        snoozedUntil: new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 16, 45).getTime(),
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // jsdom cannot evaluate `@media (hover: none)`, so the regression this
  // guards — a touch layout that faded the status out behind the park actions
  // — only shows in the class contract. The structural half is asserted too:
  // status and actions are rendered together, and neither is hidden.
  it("keeps the status beside the touch park actions instead of fading it out", async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const parkable = [
      ["Touch failed", "unread-error", "Failed"],
      ["Touch unread", "unread-success", "Unread"],
      // A question bb reports without a pending interaction is still parkable.
      ["Touch asked", "waiting-for-input", "Needs you"],
      ["Touch idle", "none", "4m"],
    ] as const;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: parkable.map(([title, indicator]) =>
          thread({
            id: title,
            title,
            indicator,
            updatedAt: minute - 4 * 60_000,
          }),
        ),
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    await screen.findByText("Touch failed");
    for (const [title, , statusText] of parkable) {
      const row = screen.getByText(title).closest("li")!;
      // The actions the touch layout has to sit beside, not on top of.
      expect(within(row).getByRole("combobox", { name: "Snooze thread" })).toBeDefined();
      expect(within(row).getByRole("button", { name: "Settle thread" })).toBeDefined();
      // The card's anchor is a sibling of the controls, not their ancestor.
      expect(nestedInteractiveControls(row)).toEqual([]);

      const { status, statusWrapper, slot, actions } = statusSlotParts(row, statusText);
      expect(actions).not.toBe(statusWrapper);
      expect(status.getAttribute("aria-hidden")).toBeNull();
      expect(status.hasAttribute("hidden")).toBe(false);
      expect(statusWrapper.getAttribute("aria-hidden")).toBeNull();
      // Touch: both spans return to the flow at full opacity, and the slot
      // widens so they sit side by side instead of stacked.
      for (const className of ["[@media(hover:none)]:static", "[@media(hover:none)]:opacity-100"]) {
        expect(statusWrapper.className).toContain(className);
        expect(actions.className).toContain(className);
      }
      expect(slot.className).toContain("[@media(hover:none)]:w-auto");
      expect(slot.className).toContain("[@media(hover:none)]:gap-1.5");
      expect(statusWrapper.className).not.toContain("[@media(hover:none)]:opacity-0");
      // A hover device still trades the status for the actions.
      expect(statusWrapper.className).toContain("[@media(hover:hover)]:group-hover/card:opacity-0");
    }
  });

  // Opening the snooze menu pins the actions open on a hover device by hiding
  // the status. On touch the two already share the row, so the status stays.
  it("keeps the touch status visible while the snooze menu is open", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_open", title: "Menu open", indicator: "unread-error" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const row = (await screen.findByText("Menu open")).closest("li")!;
    fireEvent.keyDown(within(row).getByRole("combobox", { name: "Snooze thread" }), { key: "Enter" });
    await screen.findByRole("option", { name: "1 hour" });

    const { statusWrapper } = statusSlotParts(row, "Failed");
    expect(within(row).getByText("Failed")).toBeDefined();
    expect(statusWrapper.className).toContain("opacity-0");
    expect(statusWrapper.className).toContain("[@media(hover:none)]:opacity-100");
  });

  // A thread that needs you can be put off with Snooze, but not parked or
  // settled, and its status shares the touch row with that one action.
  it("offers Snooze but not Settle on a thread that needs you", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_pending",
            title: "Still asking",
            hasPendingInteraction: true,
            indicator: "waiting-for-input",
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const row = (await screen.findByText("Still asking")).closest("li")!;
    expect(within(row).getByRole("combobox", { name: "Snooze thread" })).toBeDefined();
    expect(within(row).queryByRole("button", { name: "Settle thread" })).toBeNull();
    const { status, statusWrapper } = statusSlotParts(row, "Needs you");
    expect(status.getAttribute("aria-hidden")).toBeNull();
    expect(statusWrapper.className).toContain("[@media(hover:none)]:opacity-100");
  });

  // A working thread cannot be parked or snoozed, so it has no actions to
  // share the slot with, but it must still show its status on touch.
  it("keeps the status on rows that offer no park actions", async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem("bb-sidebar:working-since:v1", JSON.stringify({ thr_working: now - 5 * 60_000 }));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_working",
            title: "Still working",
            indicator: "runtime",
            indicatorLabel: "Agent is working",
            updatedAt: now,
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    await screen.findByText("Still working");
    for (const [title, statusText] of [["Still working", "Working · 5m"]] as const) {
      const row = screen.getByText(title).closest("li")!;
      expect(within(row).queryByRole("combobox", { name: "Snooze thread" })).toBeNull();
      expect(within(row).queryByRole("button", { name: "Settle thread" })).toBeNull();
      const { status, statusWrapper, slot } = statusSlotParts(row, statusText);
      expect(status.getAttribute("aria-hidden")).toBeNull();
      expect(statusWrapper.className).not.toContain("opacity-0");
      // Intrinsic width with a floor: nothing is layered over the status.
      expect(slot.className).toContain("w-auto");
      expect(slot.className).toContain("min-w-20");
    }
  });

  it("settles a thread when the user clicks Settle", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        settle: (input) => {
          settled = (input as { threadId: string }).threadId;
          return { ok: true, reclaim: SETTLED_NOTHING };
        },
      },
    });
    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() => expect(settled).toBe("thr_park"));
  });

  it("plays the settle sweep before settling, unless motion is reduced", async () => {
    for (const reduced of [false, true]) {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: reduced && query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      let settled: string | null = null;
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_park", title: "Quiet" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          settle: (input) => {
            settled = (input as { threadId: string }).threadId;
            return { ok: true, reclaim: SETTLED_NOTHING };
          },
        },
      });
      const button = await screen.findByLabelText("Settle thread");
      fireEvent.click(button);
      const card = button.closest("[data-parent-card]")!;
      if (reduced) {
        expect(card.hasAttribute("data-settling")).toBe(false);
      } else {
        expect(card.hasAttribute("data-settling")).toBe(true);
        expect(card.querySelector(".bb-sidebar-settle-sweep")).not.toBeNull();
        // A second click while the sweep plays is not a second settle.
        fireEvent.click(button);
        expect(settled).toBeNull();
      }
      await waitFor(() => expect(settled).toBe("thr_park"));
      rendered.unmount();
    }
  });

  // A raised hand outranks a reported runtime in the slot, and it also
  // outranks any stored shelf: the row stays on Active with no park controls.
  it("prefers a pending question to a running indicator on a parent card", async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem("bb-sidebar:working-since:v1", JSON.stringify({ thr_ask: now - 5 * 60_000 }));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_ask",
            title: "Asking while working",
            hasPendingInteraction: true,
            indicator: "runtime",
            indicatorLabel: "Agent is working",
            updatedAt: now,
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      // Settled in the store, but a raised hand brings it straight back.
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_ask",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });

    const active = screen.getByRole("region", { name: "Active" });
    const row = (await within(active).findByText("Asking while working")).closest("li")!;
    expect(within(row).getByText("Needs you")).toBeDefined();
    expect(within(row).queryByText(/^Working/)).toBeNull();
    expect(within(row).getByLabelText("Needs you")).toBeDefined();
    expect(within(row).queryByLabelText("Agent is working")).toBeNull();
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
  });

  // Parked rows share the status vocabulary: a settled thread that failed
  // says so rather than falling back to its age.
  it("shows a settled row's status instead of its age", async () => {
    const now = Date.now();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_settled",
            title: "Settled failure",
            indicator: "unread-error",
            indicatorLabel: "Unread thread failed",
            updatedAt: now - (3 * 3_600_000 + 60_000),
            createdAt: now - (3 * 3_600_000 + 60_000),
            latestAttentionAt: now - (3 * 3_600_000 + 60_000),
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_settled",
              settledAt: now,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });

    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { expanded: false }));
    const row = within(shelf).getByText("Settled failure").closest("li")!;
    expect(within(row).getByText("Failed").className).toContain("text-[color:var(--bb-sidebar-tone-error)]");
    expect(within(row).queryByText("3h")).toBeNull();
    expect(within(row).getByRole("button", { name: "Un-settle thread" })).toBeDefined();
  });

  it("keeps the last usable view when lifecycle refresh fails", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_available", title: "Still available" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => Promise.reject(new Error("backend reloading")),
      },
    });

    expect(screen.getByText("Still available")).toBeDefined();
    await waitFor(() => expect(screen.getByText("Still available")).toBeDefined());
  });
});
