// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, loadInboxApp } from "./test-inbox";
import type { ThreadWorking } from "./child-status";
import { holdsUnreadForWork, isThreadWorkingForDisplay, isWorkingTree, withUnreadHeld } from "./working-tree";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const projects = [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }];
const noRowStatus: ThreadWorking = (candidate) => isThreadWorkingForDisplay(candidate, null);
const InboxComponent = inbox.component;

const finishedParent = (overrides: Partial<PluginSidebarThread> = {}) =>
  thread({ id: "parent", title: "Parent", indicator: "unread-success", isUnread: true, ...overrides });
const runningChild = (overrides: Partial<PluginSidebarThread> = {}) =>
  thread({ id: "child", title: "Child", parentThreadId: "parent", indicator: "runtime", ...overrides });
const agents = (backgroundAgents: number, backgroundCommands = 0) => ({
  workflows: 0,
  backgroundAgents,
  backgroundCommands,
  planMode: 0,
});

/**
 * bb hands the plugin a fixed thread list per render, so a change to a thread
 * edits the list in place and remounts the inbox, as a fresh snapshot would.
 */
function mountInbox(threads: PluginSidebarThread[], settings: Record<string, unknown> = {}) {
  const rendered = renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    rpc: {
      getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: false, ...settings }),
      listLifecycle: () => ({ rows: [] }),
    },
  });
  let mounts = 0;
  return {
    update(next: PluginSidebarThread) {
      threads[threads.findIndex((row) => row.id === next.id)] = next;
      mounts += 1;
      rendered.rerender(<InboxComponent key={mounts} {...listProps} />);
    },
  };
}

const parentLink = () => screen.findByRole("link", { name: "Parent" });
const parentCard = async () => (await parentLink()).closest("[data-parent-card]") as HTMLElement;
const emphasis = (card: HTMLElement) => card.querySelector("[data-row-emphasis]")?.getAttribute("data-row-emphasis");
const status = (card: HTMLElement, label: string) => within(card).queryByText(label);

describe("a parent's Unread while its subagents work", () => {
  it("waits for a running child, then shows once the child is idle", async () => {
    const view = mountInbox([finishedParent(), runningChild()]);
    const held = await parentCard();
    expect(status(held, "Unread")).toBeNull();
    expect(emphasis(held)).not.toBe("unread");

    view.update(thread({ id: "child", title: "Child", parentThreadId: "parent" }));
    const done = await parentCard();
    expect(status(done, "Unread")).not.toBeNull();
    expect(emphasis(done)).toBe("unread");
  });

  it("waits for a grandchild working under an idle child", async () => {
    mountInbox([
      finishedParent(),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
      thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child", indicator: "runtime" }),
    ]);
    const card = await parentCard();
    expect(status(card, "Unread")).toBeNull();
    expect(emphasis(card)).not.toBe("unread");
  });

  it("waits for the thread's own background agents and reads Agent meanwhile", async () => {
    const view = mountInbox([finishedParent({ activity: agents(1) })]);
    const held = await parentCard();
    expect(status(held, "Unread")).toBeNull();
    expect(status(held, "Agent")).not.toBeNull();
    expect(emphasis(held)).not.toBe("unread");

    view.update(finishedParent());
    expect(status(await parentCard(), "Unread")).not.toBeNull();
  });

  it.each([
    [
      "a descendant is asking for input",
      [
        thread({
          id: "child",
          title: "Child",
          parentThreadId: "parent",
          indicator: "waiting-for-input",
          hasPendingInteraction: true,
        }),
        thread({ id: "other", title: "Other", parentThreadId: "parent", indicator: "runtime" }),
      ],
      "Unread",
    ],
    ["a descendant failed and nothing else runs", [runningChild({ indicator: "unread-error" })], "Unread"],
    ["only a failed descendant is working", [runningChild({ indicator: "unread-error", status: "active" })], "Unread"],
  ] as const)("still shows Unread when %s", async (_name, children, label) => {
    mountInbox([finishedParent(), ...children]);
    expect(status(await parentCard(), label)).not.toBeNull();
  });

  it("keeps a failed parent Failed while a child runs", async () => {
    mountInbox([finishedParent({ indicator: "unread-error" }), runningChild()]);
    expect(status(await parentCard(), "Failed")).not.toBeNull();
  });

  it("is not held by the thread's own background command", async () => {
    mountInbox([finishedParent({ activity: agents(0, 1) })]);
    const card = await parentCard();
    expect(status(card, "Unread")).not.toBeNull();
    expect(emphasis(card)).toBe("unread");
  });

  it("keeps the compact row's title light while held", async () => {
    const compact = { threadDisplay: "compact-all", compactWorkingThreads: true };
    const view = mountInbox([finishedParent(), runningChild()], compact);
    const title = async () => within(await parentCard()).getByText("Parent");
    expect((await title()).className).not.toContain("font-medium");
    expect(status(await parentCard(), "Unread")).toBeNull();

    view.update(thread({ id: "child", title: "Child", parentThreadId: "parent" }));
    expect((await title()).className).toContain("font-medium");
  });

  it("leaves Mark read on the real unread state", async () => {
    mountInbox([finishedParent(), runningChild()]);
    fireEvent.contextMenu(await parentLink());
    expect(await screen.findByRole("menuitem", { name: "Mark read" })).toBeDefined();
  });

  it("gives a collapsed project group no done dot for a held parent until its work ends", async () => {
    localStorage.setItem("bb-sidebar:active-sort:v1", "project");
    const view = mountInbox([
      finishedParent({ activity: agents(1) }),
      thread({ id: "other", title: "Other", createdAt: 50 }),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "bb (2)" }));
    expect(document.querySelector("[data-group-alert]")).toBeNull();

    view.update(finishedParent());
    expect(await screen.findByRole("button", { name: /^bb \(2\)/ })).toBeDefined();
    expect(document.querySelector('[data-group-alert="done"]')).not.toBeNull();
  });
});

describe("holdsUnreadForWork", () => {
  const parent = finishedParent();
  const none = new Map<string, readonly PluginSidebarThread[]>();

  it("never holds a thread that is not an unread result", () => {
    for (const indicator of ["none", "runtime", "unread-error", "waiting-for-input"] as const) {
      expect(holdsUnreadForWork({ ...parent, indicator }, [runningChild()], none, noRowStatus)).toBe(false);
    }
  });

  it("holds on a running child and on the thread's own background agents", () => {
    expect(holdsUnreadForWork(parent, [runningChild()], none, noRowStatus)).toBe(true);
    expect(holdsUnreadForWork({ ...parent, activity: agents(2) }, [], none, noRowStatus)).toBe(true);
    expect(holdsUnreadForWork(parent, [], none, noRowStatus)).toBe(false);
  });

  it("releases when a descendant asks for input", () => {
    const asking = thread({ id: "ask", parentThreadId: "parent", hasPendingInteraction: true });
    expect(holdsUnreadForWork(parent, [runningChild(), asking], none, noRowStatus)).toBe(false);
  });

  it("shows the held thread read, with its own agents or its age", () => {
    expect(withUnreadHeld(parent)).toMatchObject({ isUnread: false, indicator: "none" });
    expect(withUnreadHeld({ ...parent, activity: agents(1) })).toMatchObject({
      isUnread: false,
      indicator: "background-agent",
    });
  });

  it("leaves isWorkingTree as it was for the same threads", () => {
    expect(isWorkingTree(parent, [runningChild()], none, noRowStatus)).toBe(true);
    expect(isWorkingTree(parent, [], none, noRowStatus)).toBe(false);
  });
});
