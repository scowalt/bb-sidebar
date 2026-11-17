// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createWired } from "./test-wired";
import { loadInboxApp, thread } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
await loadInboxApp();

const card = (title: string) => screen.getByRole("link", { name: title }).closest("li")!;

describe("snoozing a thread that needs you", () => {
  it("puts its question and its child's off until the wake time, through the real server", async () => {
    const now = Date.now();
    const wired = await createWired([
      thread({ id: "parent", title: "Asks twice", hasPendingInteraction: true, updatedAt: now }),
      thread({
        id: "child",
        title: "Child asks",
        parentThreadId: "parent",
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
        updatedAt: now,
      }),
      thread({ id: "other", title: "Other thread", updatedAt: now }),
    ]);
    wired.mount();

    const snooze = await waitFor(() => within(card("Asks twice")).getByRole("combobox", { name: "Snooze thread" }));
    expect(within(card("Asks twice")).queryByRole("button", { name: "Settle thread" })).toBeNull();
    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "1 hour" }));

    await waitFor(() =>
      expect(
        wired.db.prepare("SELECT snoozed_question_thread_ids FROM thread_lifecycle WHERE thread_id = ?").get("parent"),
      ).toEqual({ snoozed_question_thread_ids: JSON.stringify(["parent", "child"]) }),
    );
    await wired.flush();
    const snoozed = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(snoozed).getByRole("button", { name: /^Snoozed/ }));
    expect(await within(snoozed).findByText("Asks twice")).toBeDefined();
    const active = screen.getByRole("region", { name: "Active" });
    expect(within(active).queryByText("Asks twice")).toBeNull();
    expect(within(active).getByText("Other thread")).toBeDefined();
  });
});
