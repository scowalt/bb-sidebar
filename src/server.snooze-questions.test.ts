import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createFakePluginHost, disposers, projectThread, projectsWith, type ProjectThread } from "./test-server";

async function setup(initial: ProjectThread[]) {
  let threads = initial;
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      projects: { list: async () => projectsWith(threads) },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        unpin: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        stop: async ({ threadId }) => makeThreadResponse({ id: threadId }),
      },
    },
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const shelf = async (threadId: string) => {
    const result = await harness.behavior.runCli(["list", "--all", "--json"], {});
    const { threads: listed } = JSON.parse(result.stdout) as { threads: { threadId: string; shelf: string }[] };
    return listed.find((thread) => thread.threadId === threadId)?.shelf;
  };
  return {
    harness,
    shelf,
    asks: (threadId: string, hasPendingInteraction: boolean) => {
      threads = threads.map((thread) => (thread.id === threadId ? { ...thread, hasPendingInteraction } : thread));
    },
  };
}

describe("bb sidebar snooze on a thread that needs you", () => {
  const tree = () => [
    projectThread({ id: "parent", hasPendingInteraction: true, latestAttentionAt: 1 }),
    projectThread({ id: "child", parentThreadId: "parent", latestAttentionAt: 1 }),
  ];

  it("keeps it snoozed over that question until another thread asks", async () => {
    const state = await setup(tree());
    const result = await state.harness.behavior.runCli(["snooze", "2h"], { threadId: "parent" });
    expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/^snoozed parent until /) });
    expect(await state.shelf("parent")).toBe("snoozed");

    state.asks("child", true);
    expect(await state.shelf("parent")).toBe("active");
  });

  it("still wakes on a question when it was snoozed without one", async () => {
    const state = await setup(tree());
    state.asks("parent", false);
    await state.harness.behavior.runCli(["snooze", "2h"], { threadId: "parent" });
    expect(await state.shelf("parent")).toBe("snoozed");

    state.asks("parent", true);
    expect(await state.shelf("parent")).toBe("active");
  });
});
