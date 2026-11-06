import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  createFakePluginHost,
  disposers,
  loadPlugin,
  projectThread,
  projectsWith,
  pullRequestStatus,
  terminalSession,
  type LifecycleListResult,
  type ProjectThread,
} from "./test-server";

const insertRow = (bb: ReturnType<typeof createFakePluginHost>["bb"], threadId: string) =>
  bb.storage
    .database()
    .prepare(
      `INSERT INTO thread_lifecycle
      (thread_id, settled_at, settled_override, parked_at, snoozed_until, snoozed_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(threadId, 100, "settled", null, null, null);

// Automatic settling would give these quiet threads rows of its own.
const manualOnly = {
  getSettings: async () => ({
    ok: true as const,
    schema: {},
    values: { autoSettleInactive: false, autoSettleOnMerge: false },
  }),
};

async function loadWith(threads: () => ProjectThread[]) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      plugins: { ...manualOnly, callRpc: pullRequestStatus(() => ({ outcome: "absent" })) },
      projects: { list: async () => projectsWith(threads()) },
      threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) },
    },
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  return { bb, harness };
}

const rowsOf = async (harness: Awaited<ReturnType<typeof loadWith>>["harness"]) =>
  ((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows;

describe("children of older parent-only settles", () => {
  it("gives quiet children their settled ancestor's row once", async () => {
    const threads = [
      projectThread({ id: "parent", latestAttentionAt: 50 }),
      projectThread({ id: "quiet", parentThreadId: "parent", latestAttentionAt: 90 }),
      projectThread({ id: "grandchild", parentThreadId: "quiet", latestAttentionAt: 90 }),
      projectThread({ id: "hidden", parentThreadId: "parent", visibility: "hidden", latestAttentionAt: 90 }),
      projectThread({ id: "newer", parentThreadId: "parent", latestAttentionAt: 150 }),
      projectThread({ id: "working", parentThreadId: "parent", status: "active", latestAttentionAt: 90 }),
      projectThread({ id: "asking", parentThreadId: "parent", hasPendingInteraction: true, latestAttentionAt: 90 }),
      projectThread({ id: "unrelated", latestAttentionAt: 90 }),
    ];
    const { bb, harness } = await loadWith(() => threads);
    insertRow(bb, "parent");

    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: expect.arrayContaining(["quiet", "grandchild", "hidden"]),
    });
    const inherited = {
      parkedAt: null,
      settledAt: 100,
      settledOverride: "settled",
      snoozedUntil: null,
      snoozedAt: null,
      snoozePending: false,
    };
    expect(await rowsOf(harness)).toEqual([
      { threadId: "parent", ...inherited },
      { threadId: "quiet", ...inherited },
      { threadId: "grandchild", ...inherited },
      { threadId: "hidden", ...inherited },
    ]);
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "lifecycle",
      payload: { threadIds: ["quiet", "grandchild", "hidden"] },
    });

    // A later rowless child is not legacy data. The repair does not run again.
    bb.storage.database().prepare("DELETE FROM thread_lifecycle WHERE thread_id = 'quiet'").run();
    await harness.behavior.callRpc("evaluateAutoSettle", {});
    expect((await rowsOf(harness)).map((row) => row.threadId)).toEqual(["parent", "grandchild", "hidden"]);
  });

  it("leaves children alone when the ancestor no longer shows as settled", async () => {
    const threads = [
      projectThread({ id: "parent", latestAttentionAt: 200 }),
      projectThread({ id: "child", parentThreadId: "parent", latestAttentionAt: 90 }),
    ];
    const { bb, harness } = await loadWith(() => threads);
    insertRow(bb, "parent");
    await harness.behavior.callRpc("evaluateAutoSettle", {});
    expect((await rowsOf(harness)).map((row) => row.threadId)).toEqual(["parent"]);
  });

  it("stops protecting the shared workspace once the child has its row", async () => {
    const shared = { environmentId: "env_shared", environmentHostId: "host_1", environmentPath: "/workspace/shared" };
    const threads = [
      projectThread({ id: "parent", title: "Parent", latestAttentionAt: 50, ...shared }),
      projectThread({ id: "child", title: "Child", parentThreadId: "parent", latestAttentionAt: 90, ...shared }),
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots")
          return {
            roots: (input as { roots: Array<{ environmentId: string }> }).roots.map((root) => ({
              environmentId: root.environmentId,
              path: "/workspace/shared",
            })),
          };
        if (method === "scan") return { ports: [] };
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        plugins: { ...manualOnly, callRpc: pullRequestStatus(() => ({ outcome: "absent" })) },
        projects: { list: async () => projectsWith(threads) },
        threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env_shared" }) },
        environments: {
          get: async () =>
            ({ id: "env_shared", hostId: "host_1", path: "/workspace/shared", status: "ready" }) as Awaited<
              ReturnType<typeof bb.sdk.environments.get>
            >,
        },
        terminals: {
          list: async ({ scope }) => ({
            sessions:
              scope.threadId === "parent"
                ? [{ ...terminalSession({ id: "term_dev", environmentId: "env_shared" }), threadId: "parent" }]
                : [],
          }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    insertRow(bb, "parent");

    const before = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["parent"] })) as {
      threads: unknown[];
      skipped: unknown[];
    };
    expect(before.threads).toEqual([]);
    expect(before.skipped).toEqual([
      {
        threadId: "parent",
        resource: "terminal",
        message: 'Kept 1 terminal open: shares a workspace with "Child", which is not settled',
      },
    ]);

    await harness.behavior.callRpc("evaluateAutoSettle", {});
    const after = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["parent"] })) as {
      threads: unknown[];
      skipped: unknown[];
    };
    expect(after.threads).toEqual([expect.objectContaining({ threadId: "parent", terminalCount: 1 })]);
    expect(after.skipped).toEqual([]);
  });
});

describe("moving a thread under a settled parent", () => {
  async function setup(moved: { settled: boolean }) {
    const harness = await loadPlugin();
    let parentOf: string | null = null;
    harness.inspection.sdk.stub("projects.list", async () =>
      projectsWith([projectThread({ id: "parent" }), projectThread({ id: "moved", parentThreadId: parentOf })]),
    );
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, parentThreadId: threadId === "moved" ? parentOf : null }),
    );
    harness.inspection.sdk.stub("threads.update", async ({ threadId, parentThreadId }) => {
      parentOf = parentThreadId ?? null;
      return makeThreadResponse({ id: threadId, parentThreadId: parentOf });
    });
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    if (moved.settled) await harness.behavior.callRpc("settle", { threadId: "moved" });
    await harness.behavior.callRpc("setThreadParent", { threadId: "moved", parentThreadId: "parent" });
    return ((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows;
  }

  it("returns the parent to Active when the moved thread is not settled", async () => {
    expect(await setup({ settled: false })).toEqual([]);
  });

  it("keeps the parent settled when the moved thread is settled too", async () => {
    expect((await setup({ settled: true })).map((row) => row.threadId)).toEqual(["parent", "moved"]);
  });
});
