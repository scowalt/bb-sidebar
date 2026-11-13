// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { createWired } from "./test-wired";
import { loadInboxApp, thread } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
await loadInboxApp();

const HOUR_MS = 3_600_000;

const waiting = (id: string, title: string) =>
  thread({ id, title, displayTitle: title, queuedWork: "waiting", updatedAt: Date.now() });
const card = (title: string) => screen.getByRole("link", { name: title }).closest("li")!;

async function menuFor(element: HTMLElement) {
  fireEvent.contextMenu(element);
  return screen.findByRole("menu", { name: "Thread actions" });
}

async function closeMenu(menu: HTMLElement) {
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull());
}

describe("a thread whose only queued message is scheduled for later", () => {
  it("offers Snooze but not Park, Settle or Archive, and stays Snoozed without them once snoozed", async () => {
    const wired = await createWired([waiting("wakeup", "Agent wakeup"), waiting("offline", "Offline send")]);
    const queues: Record<string, ReturnType<typeof makeQueueEntry>[]> = {
      wakeup: [
        makeQueueEntry({
          threadId: "wakeup",
          state: "scheduled",
          waitingOn: { kind: "time" },
          sendAt: Date.now() + 2 * HOUR_MS,
        }),
      ],
      offline: [
        makeQueueEntry({ threadId: "offline", state: "waiting", waitingOn: { kind: "host-offline", hostName: "Mac" } }),
      ],
    };
    wired.harness.inspection.sdk.stub(
      "threads.queuedMessages.list",
      async ({ threadId }: { threadId: string }) => queues[threadId] ?? [],
    );
    wired.mount();

    const snooze = await waitFor(() => within(card("Agent wakeup")).getByRole("combobox", { name: "Snooze thread" }));
    expect(within(card("Agent wakeup")).queryByRole("button", { name: "Settle thread" })).toBeNull();
    const menu = await menuFor(screen.getByText("Agent wakeup"));
    expect(within(menu).getByText("Snooze")).toBeDefined();
    for (const item of ["Park thread", "Settle"]) expect(within(menu).queryByText(item)).toBeNull();
    expect(within(menu).getByText("Archive").getAttribute("data-disabled")).not.toBeNull();
    await closeMenu(menu);

    expect(within(card("Offline send")).queryByRole("combobox", { name: "Snooze thread" })).toBeNull();
    const offlineMenu = await menuFor(screen.getByText("Offline send"));
    for (const item of ["Snooze", "Park thread", "Settle"]) expect(within(offlineMenu).queryByText(item)).toBeNull();
    await closeMenu(offlineMenu);

    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "1 hour" }));
    await waitFor(() =>
      expect(wired.db.prepare("SELECT snoozed_until FROM thread_lifecycle WHERE thread_id = ?").get("wakeup")).toEqual({
        snoozed_until: expect.any(Number),
      }),
    );
    await wired.flush();
    const snoozed = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(snoozed).getByRole("button", { name: /^Snoozed/ }));
    const snoozedMenu = await menuFor(await within(snoozed).findByText("Agent wakeup"));
    expect(within(snoozedMenu).getByText("Wake now")).toBeDefined();
    for (const item of ["Park thread", "Settle"]) expect(within(snoozedMenu).queryByText(item)).toBeNull();
    expect(within(snoozedMenu).getByText("Archive").getAttribute("data-disabled")).not.toBeNull();
    await closeMenu(snoozedMenu);
    const active = screen.getByRole("region", { name: "Active" });
    expect(within(active).queryByText("Agent wakeup")).toBeNull();
    expect(within(active).getByText("Offline send")).toBeDefined();
  });
});
