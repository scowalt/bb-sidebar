import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { resolveShelf, resolveWakeReason, type ThreadActivitySignals } from "./lifecycle";
import { createFakePluginHost, disposers, projectThread, projectsWith, type LifecycleListResult } from "./test-server";

const DAY_MS = 24 * 60 * 60_000;

/** One thread whose turn status and attention the test moves along. */
async function setup() {
  let thread = projectThread({ id: "thr_self", status: "active", latestAttentionAt: Date.now() - 1_000 });
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      projects: { list: async () => projectsWith([thread]) },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        unpin: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        stop: async ({ threadId }) => makeThreadResponse({ id: threadId }),
      },
    },
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const row = async () => {
    const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    return rows.find((candidate) => candidate.threadId === thread.id);
  };
  const signals = (): ThreadActivitySignals => ({
    hasPendingInteraction: thread.hasPendingInteraction,
    hasQueuedWork: thread.queuedWork !== "none",
    isWorking: thread.status !== "idle" && thread.status !== "error",
    isUnread: true,
    latestAttentionAt: thread.latestAttentionAt,
  });
  return {
    harness,
    row,
    signals,
    set: (changes: Partial<typeof thread>) => {
      thread = { ...thread, ...changes };
    },
    /** The turn ends with the agent's own final reply. */
    finishTurn: async (status: "idle" | "error" = "idle") => {
      thread = { ...thread, status, latestAttentionAt: Date.now() + 5 };
      const response = makeThreadResponse({ id: thread.id, status, latestAttentionAt: thread.latestAttentionAt });
      if (status === "idle") {
        await harness.behavior.emitThreadEvent("thread.idle", { thread: response, lastAssistantText: "Snoozed." });
      } else {
        await harness.behavior.emitThreadEvent("thread.failed", { thread: response, error: "boom" });
      }
    },
  };
}

describe("an agent snoozing its own thread", () => {
  it("stays snoozed after the agent's final reply", async () => {
    const state = await setup();
    const result = await state.harness.behavior.runCli(["snooze", "2d"], { threadId: "thr_self" });
    expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/^snoozed thr_self until .*turn ends/) });

    // While the turn runs the thread stays Active, and no Woke marker shows
    // for the agent's own progress messages.
    state.set({ latestAttentionAt: Date.now() + 1 });
    expect(resolveShelf(await state.row(), state.signals(), Date.now())).toBe("active");
    expect(resolveWakeReason(await state.row(), state.signals(), Date.now())).toBeNull();
    expect(state.harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);

    await state.finishTurn();
    // The runtime is released once the turn is over, as a snooze of an idle thread does.
    expect(state.harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_self" }]]);
    const row = await state.row();
    expect(row).toMatchObject({ snoozePending: false, snoozedAt: expect.any(Number) });
    expect(resolveShelf(row, state.signals(), Date.now())).toBe("snoozed");
    expect(resolveWakeReason(row, state.signals(), Date.now())).toBeNull();
  });

  it("still wakes on new attention after the turn", async () => {
    const state = await setup();
    await state.harness.behavior.runCli(["snooze", "2d"], { threadId: "thr_self" });
    await state.finishTurn();

    state.set({ latestAttentionAt: Date.now() + 1_000 });
    expect(resolveWakeReason(await state.row(), state.signals(), Date.now())).toBe("attention");
    expect(resolveShelf(await state.row(), state.signals(), Date.now())).toBe("active");
  });

  it("wakes on a question asked after the turn", async () => {
    const state = await setup();
    await state.harness.behavior.runCli(["snooze", "2d"], { threadId: "thr_self" });
    await state.finishTurn();

    state.set({ hasPendingInteraction: true });
    expect(resolveWakeReason(await state.row(), state.signals(), Date.now())).toBe("attention");
  });

  it("drops the snooze when the snoozing turn fails", async () => {
    const state = await setup();
    await state.harness.behavior.runCli(["snooze", "2d"], { threadId: "thr_self" });
    await state.finishTurn("error");

    expect(await state.row()).toBeUndefined();
    expect(resolveShelf(await state.row(), state.signals(), Date.now())).toBe("active");
  });

  it("starts a snooze of an idle thread at once", async () => {
    const state = await setup();
    state.set({ status: "idle" });
    await state.harness.behavior.callRpc("snooze", { threadId: "thr_self", snoozedUntil: Date.now() + DAY_MS });

    expect(await state.row()).toMatchObject({ snoozePending: false, snoozedAt: expect.any(Number) });
    expect(resolveShelf(await state.row(), state.signals(), Date.now())).toBe("snoozed");
  });

  it("starts a pending snooze if the turn ended while it was being written", async () => {
    const state = await setup();
    let listed = 0;
    // The first lookup still sees the turn; the recheck after the write does not.
    state.harness.inspection.sdk.stub("threads.list", async () => {
      listed += 1;
      return [projectThread({ id: "thr_self", status: listed === 1 ? "active" : "idle" })];
    });
    await state.harness.behavior.callRpc("snooze", { threadId: "thr_self", snoozedUntil: Date.now() + DAY_MS });

    expect(await state.row()).toMatchObject({ snoozePending: false, snoozedAt: expect.any(Number) });
  });

  it("starts a snooze left pending by an earlier server from when it was requested", async () => {
    const state = await setup();
    await state.harness.behavior.runCli(["snooze", "2d"], { threadId: "thr_self" });
    const pending = await state.row();
    expect(pending).toMatchObject({ snoozePending: true });

    const replacement = await state.harness.lifecycle.reload(plugin);
    disposers.push(() => replacement.harness.lifecycle.dispose());
    const { rows } = (await replacement.harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    // The final reply was missed, so it may wake the thread; nothing is hidden.
    expect(rows).toEqual([{ ...pending, snoozePending: false }]);
  });
});
