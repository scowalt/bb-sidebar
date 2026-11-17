import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server";
import { createFakePluginHost, projectThread, projectsWith, type ProjectThread } from "./test-server";
import { pullRequestsTag } from "./rpc-tags";
import type { PullRequestFacts, ThreadPullRequests } from "./pull-request-status";
import type { PullRequestLookupResult } from "./port-scan-contract";

type Sdk = BbPluginApi["sdk"];
type Event = { seq: number; type: string; data: unknown };

const url = (number: number) => `https://git.example.com/o/r/pulls/${number}`;
const TAG = pullRequestsTag("thr_a");

function created(seq: number, number: number): Event {
  return {
    seq,
    type: "item/completed",
    data: { item: { type: "commandExecution", command: "tea pr create --repo o/r", aggregatedOutput: url(number) } },
  };
}

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    title: `PR`,
    state: "open",
    draft: false,
    mergeable: true,
    checks: { total: 1, passed: 1, pending: 0, failing: [] },
    review: null,
    head: "feature",
    base: "main",
    mergedAt: null,
    additions: 1,
    deletions: 0,
    ...overrides,
  };
}
const merged = facts({ state: "merged", mergedAt: "2026-11-01T00:00:00Z" });
const pending = facts({ checks: { total: 2, passed: 1, pending: 1, failing: [] } });
const found = (target: string, value: PullRequestFacts): PullRequestLookupResult => ({
  url: target,
  outcome: "found",
  facts: value,
});

const onHost = (overrides: Partial<ProjectThread> & { id: string }) =>
  projectThread({ environmentId: `env_${overrides.id}`, environmentHostId: "host_a", ...overrides });

/** bb's thread list, as the tracker's targeted lookups use it: by id, unknown ids left out. */
function threadList(threads: ProjectThread[]) {
  return vi.fn(async (args?: { threadIds?: readonly string[]; limit?: number; offset?: number }) => {
    const matching = args?.threadIds ? threads.filter((thread) => args.threadIds!.includes(thread.id)) : threads;
    const offset = args?.offset ?? 0;
    return matching.slice(offset, offset + (args?.limit ?? 100));
  }) as unknown as Sdk["threads"]["list"] & { mock: { calls: [{ threadIds?: readonly string[] }][] } };
}

async function mount({
  events = {},
  threads = [onHost({ id: "thr_a" })],
  answer = (target: string) => found(target, facts()),
  callRpc,
  threadsList,
}: {
  events?: Record<string, Event[]>;
  threads?: ProjectThread[];
  answer?: (url: string) => PullRequestLookupResult | Error;
  callRpc?: Sdk["plugins"]["callRpc"];
  threadsList?: Sdk["threads"]["list"];
} = {}) {
  const list = vi.fn(async ({ threadId, afterSeq, limit }: { threadId: string; afterSeq?: string; limit: string }) => {
    if (Number(limit) > 100) throw new Error("Thread event limit cannot exceed 100");
    return (events[threadId] ?? []).filter((event) => event.seq > Number(afterSeq ?? 0)).slice(0, Number(limit));
  });
  const hostCall = vi.fn(async ({ method, input }: { method: string; input: unknown }) => {
    if (method !== "lookUpPullRequests") throw new Error(`Unexpected host call ${method}`);
    const results = (input as { urls: string[] }).urls.map(answer);
    const failure = results.find((result): result is Error => result instanceof Error);
    if (failure) throw failure;
    return { pullRequests: results };
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    experimental_callHostRpc: hostCall,
    sdk: {
      ...(callRpc ? { plugins: { callRpc } } : {}),
      projects: { list: async () => projectsWith(threads) },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        events: { list } as unknown as Sdk["threads"]["events"],
        ...(threadsList ? { list: threadsList } : {}),
      },
    },
  });
  await plugin(bb);
  const read = async (threadId = "thr_a") =>
    ((await harness.behavior.callRpc("getPullRequests", { keys: [threadId] })) as Record<string, ThreadPullRequests>)[
      threadId
    ]!;
  const lookups = () => hostCall.mock.calls.map(([call]) => (call.input as { urls: string[] }).urls);
  const invalidations = () => harness.inspection.experimental_rpcInvalidations.map((tags) => tags ?? ["all"]);
  const settle = (threadId: string) =>
    bb.storage
      .database()
      .prepare(`INSERT INTO thread_lifecycle (thread_id, settled_at, settled_override) VALUES (?, 1, 'settled')`)
      .run(threadId);
  return { bb, harness, list, hostCall, read, lookups, invalidations, settle, events };
}

const tick = () => vi.advanceTimersByTimeAsync(300);

let disposers: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  vi.useRealTimers();
});
const keep = (harness: Awaited<ReturnType<typeof mount>>["harness"]) =>
  disposers.push(() => harness.lifecycle.dispose());

it("reads nothing and does no work until a client watches the thread", async () => {
  const host = await mount({ events: { thr_a: [created(1, 10)] } });
  keep(host.harness);
  expect(await host.read()).toEqual({ entries: [], scanned: false });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(host.list).not.toHaveBeenCalled();
  expect(host.hostCall).not.toHaveBeenCalled();
});

it("scans a watched thread, looks its PRs up once on its host, and invalidates only its key", async () => {
  const host = await mount({
    events: { thr_a: [created(1, 10), created(2, 11)], thr_b: [] },
    threads: [onHost({ id: "thr_a" }), onHost({ id: "thr_b" })],
    answer: (target) => found(target, target.endsWith("/10") ? merged : facts()),
  });
  keep(host.harness);
  const unwatch = host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  expect(host.list.mock.calls[0]?.[0]).toMatchObject({ threadId: "thr_a", types: ["item/completed"], limit: "100" });
  expect(host.list.mock.calls[0]?.[0]).not.toHaveProperty("afterSeq");
  expect(host.hostCall).toHaveBeenCalledTimes(1);
  expect(host.hostCall.mock.calls[0]?.[0]).toMatchObject({ hostId: "host_a", input: { urls: [url(10), url(11)] } });
  expect(await host.read()).toEqual({
    scanned: true,
    entries: [
      { url: url(10), repo: "o/r", number: 10, facts: merged },
      { url: url(11), repo: "o/r", number: 11, facts: facts() },
    ],
  });
  expect(host.invalidations()).toEqual([[TAG]]);
  expect(await host.read("thr_b")).toEqual({ entries: [], scanned: false });
  unwatch();
});

it("keeps facts across a reload and serves them without a scan", async () => {
  const host = await mount({ events: { thr_a: [created(1, 10)] } });
  const unwatch = host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  unwatch();
  const scans = host.list.mock.calls.length;
  const reloaded = await host.harness.lifecycle.reload(plugin);
  keep(reloaded.harness);
  const rows = (await reloaded.harness.behavior.callRpc("getPullRequests", { keys: ["thr_a"] })) as Record<
    string,
    ThreadPullRequests
  >;
  expect(rows.thr_a).toMatchObject({ scanned: true, entries: [{ number: 10, facts: facts() }] });
  expect(host.list.mock.calls.length).toBe(scans);
});

it("asks again about running checks every tick, open PRs after two minutes, and finished PRs never", async () => {
  const host = await mount({
    events: { thr_a: [created(1, 10), created(2, 11), created(3, 12)] },
    answer: (target) => found(target, target.endsWith("/10") ? merged : target.endsWith("/11") ? pending : facts()),
  });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  expect(host.lookups()).toEqual([[url(10), url(11), url(12)]]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(host.lookups().at(-1)).toEqual([url(11)]);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(host.lookups().at(-1)).toEqual([url(11), url(12)]);
  expect(
    host
      .lookups()
      .flat()
      .filter((target) => target === url(10)),
  ).toHaveLength(1);
});

it("shows a Gitea conflict only once two lookups in a row report one, asking again at the pending pace", async () => {
  let mergeable: boolean | null = false;
  const host = await mount({
    events: {
      thr_a: [
        created(1, 10),
        {
          seq: 2,
          type: "item/completed",
          data: {
            item: {
              type: "commandExecution",
              command: "gh pr create",
              aggregatedOutput: "https://github.com/o/r/pull/7",
            },
          },
        },
      ],
    },
    answer: (target) => found(target, facts({ mergeable })),
  });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  const mergeableOf = async (number: number) =>
    (await host.read()).entries.find((entry) => entry.number === number)?.facts?.mergeable;
  // Gitea says false while it is still checking too; GitHub's CONFLICTING is definite.
  expect(await mergeableOf(10)).toBeNull();
  expect(await mergeableOf(7)).toBe(false);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(host.lookups().at(-1)).toEqual([url(10)]);
  expect(await mergeableOf(10)).toBe(false);
  mergeable = true;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(host.lookups()).toHaveLength(3);
  expect(await mergeableOf(10)).toBe(true);
});

it("looks a settled thread up when it is watched and never on later ticks", async () => {
  const host = await mount({
    events: { thr_a: [created(1, 11)] },
    answer: (target) => found(target, pending),
  });
  keep(host.harness);
  host.settle("thr_a");
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  expect(host.lookups()).toEqual([[url(11)]]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(host.lookups()).toEqual([[url(11)]]);
});

it("places a newly watched thread by reading it and its parents, never by listing every thread", async () => {
  const threads = [
    onHost({ id: "thr_top" }),
    onHost({ id: "thr_a", parentThreadId: "thr_top" }),
    onHost({ id: "thr_b" }),
  ];
  const threadsList = threadList(threads);
  const host = await mount({
    events: { thr_a: [created(1, 10)], thr_b: [created(1, 20)] },
    threads,
    threadsList,
  });
  keep(host.harness);
  host.settle("thr_top");
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  const since = threadsList.mock.calls.length;
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_b" });
  await tick();
  expect(host.lookups()).toEqual([[url(10)], [url(20)]]);
  // Each thread is asked for by id, then its parent; no call lists everything.
  expect(threadsList.mock.calls.slice(since).map(([args]) => args?.threadIds ?? "all")).toEqual([["thr_b"]]);
  expect(threadsList.mock.calls.map(([args]) => args?.threadIds ?? "all")).toContainEqual(["thr_top"]);
  // thr_a sits on its settled parent's row: looked up at watch time and never again.
  await vi.advanceTimersByTimeAsync(150_000);
  expect(
    host
      .lookups()
      .flat()
      .filter((target) => target === url(10)),
  ).toHaveLength(1);
  expect(host.lookups().at(-1)).toEqual([url(20)]);
});

it("rescans from the last seen sequence when a watched thread's turn ends", async () => {
  const events = { thr_a: [created(1, 10)] };
  const host = await mount({ events });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  events.thr_a.push(created(2, 11));
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "thr_a" }),
    lastAssistantText: null,
  });
  await tick();
  expect(host.list.mock.calls.at(-1)?.[0]).toMatchObject({ threadId: "thr_a", afterSeq: "1" });
  expect((await host.read()).entries.map((entry) => entry.number)).toEqual([10, 11]);
  expect(host.invalidations()).toEqual([[TAG], [TAG]]);
});

it("rescans a working thread on every tick while it is watched", async () => {
  const events = { thr_a: [created(1, 10)] };
  const host = await mount({ events });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  await host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_a" }) });
  events.thr_a.push(created(2, 11));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(host.list.mock.calls.at(-1)?.[0]).toMatchObject({ afterSeq: "1" });
  expect((await host.read()).entries.map((entry) => entry.number)).toEqual([10, 11]);
});

it("looks up at most forty PRs per host per tick, rechecks before routine refreshes, and carries the rest over", async () => {
  const numbers = Array.from({ length: 41 }, (_, index) => index + 1);
  const host = await mount({
    events: { thr_a: numbers.map((number) => created(number, number)) },
    answer: (target) => found(target, target.endsWith("/41") ? pending : facts()),
  });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  expect(host.lookups().flat()).toEqual(numbers.slice(0, 40).map(url));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(host.lookups().at(-1)).toEqual([url(41)]);
  // Two minutes on, every PR is due: the running one goes first and one waits for the next tick.
  await vi.advanceTimersByTimeAsync(100_000);
  const capped = host.lookups().slice(-2).flat();
  expect(capped).toHaveLength(40);
  expect(capped[0]).toBe(url(41));
  expect(capped).not.toContain(url(40));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(host.lookups().at(-1)).toEqual([url(41), url(40)]);
});

it("stops looking up a thread's PRs once its last watcher leaves mid-tick", async () => {
  let unwatch = () => {};
  const host = await mount({
    events: { thr_a: Array.from({ length: 25 }, (_, index) => created(index + 1, index + 1)) },
    answer: (target) => {
      unwatch();
      return found(target, facts());
    },
  });
  keep(host.harness);
  unwatch = host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  expect(host.hostCall).toHaveBeenCalledTimes(1);
  expect((await host.read()).entries.filter((entry) => entry.facts === null)).toHaveLength(5);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(host.hostCall).toHaveBeenCalledTimes(1);
});

it("shares one host call between watched threads on the same host", async () => {
  const host = await mount({
    events: { thr_a: [created(1, 10)], thr_b: [created(1, 20)] },
    threads: [onHost({ id: "thr_a" }), onHost({ id: "thr_b" })],
  });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_b" });
  await tick();
  expect(host.lookups()).toEqual([[url(10), url(20)]]);
  expect(host.invalidations()).toEqual([[TAG, pullRequestsTag("thr_b")]]);
});

it("keeps the previous facts when a lookup fails and backs off before asking again", async () => {
  let answer: PullRequestLookupResult = found(url(10), facts());
  const host = await mount({ events: { thr_a: [created(1, 10)] }, answer: () => answer });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  answer = { url: url(10), outcome: "failed", reason: "timeout" };
  await vi.advanceTimersByTimeAsync(120_000);
  expect(host.lookups()).toHaveLength(2);
  expect((await host.read()).entries[0]?.facts).toEqual(facts());
  await vi.advanceTimersByTimeAsync(40_000);
  expect(host.lookups()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(host.lookups()).toHaveLength(3);
  // A thread whose list did not change is not invalidated again.
  expect(host.invalidations()).toEqual([[TAG]]);
});

it("leaves a PR the host never described as unknown, never as ready", async () => {
  const host = await mount({
    events: { thr_a: [created(1, 10)] },
    answer: (target) => ({ url: target, outcome: "failed", reason: "not_found" }),
  });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  expect(await host.read()).toMatchObject({ scanned: true, entries: [{ number: 10, facts: null }] });
});

it("treats a host that cannot run the lookup like any failed lookup: unknown facts, asked again in a minute", async () => {
  // bb's host worker answers `unknown host method "lookUpPullRequests"` when the
  // host's plugin predates the method. However the error is shaped, the PR
  // stays unknown and the usual failure backoff applies.
  const host = await mount({
    events: { thr_a: [created(1, 10)] },
    answer: () => Object.assign(new Error('unknown host method "lookUpPullRequests"'), { code: "unknown_method" }),
  });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  expect(host.hostCall).toHaveBeenCalledTimes(1);
  expect((await host.read()).entries[0]?.facts).toBeNull();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(host.hostCall).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(host.hostCall).toHaveBeenCalledTimes(2);
});

it("stops all work once the last watch ends", async () => {
  const host = await mount({ events: { thr_a: [created(1, 11)] }, answer: (target) => found(target, pending) });
  keep(host.harness);
  const unwatch = host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  unwatch();
  const scans = host.list.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(host.list.mock.calls.length).toBe(scans);
  expect(host.lookups()).toHaveLength(1);
});

it("skips threads with no workspace and discovers a worktree's branch PR from GitHub PR Status", async () => {
  const callRpc = vi.fn(async ({ input }: { input: unknown }) =>
    Object.fromEntries(
      (input as { keys: string[] }).keys.map((key) => [
        key,
        key === "env_thr_a"
          ? { outcome: "available", pullRequest: { url: "https://github.com/o/r/pull/99", attention: "none" } }
          : { outcome: "absent" },
      ]),
    ),
  ) as unknown as Sdk["plugins"]["callRpc"];
  const host = await mount({
    events: { thr_a: [created(1, 10)], thr_c: [created(1, 30)] },
    threads: [
      onHost({ id: "thr_a", environmentIsWorktree: true }),
      projectThread({ id: "thr_c", environmentId: null, environmentHostId: null }),
    ],
    callRpc,
  });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_c" });
  await tick();
  expect(host.lookups()).toEqual([[url(10), "https://github.com/o/r/pull/99"]]);
  expect((await host.read()).entries.map((entry) => entry.url)).toEqual([url(10), "https://github.com/o/r/pull/99"]);
  expect(await host.read("thr_c")).toMatchObject({ scanned: true, entries: [{ number: 30, facts: null }] });
});

it("forgets a deleted thread's rows and the PRs only it listed", async () => {
  const host = await mount({
    events: { thr_a: [created(1, 10), created(2, 11)], thr_b: [created(1, 10)] },
    threads: [onHost({ id: "thr_a" }), onHost({ id: "thr_b" })],
  });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_b" });
  await tick();
  await host.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_a" }) });
  expect(await host.read("thr_a")).toEqual({ entries: [], scanned: false });
  expect((await host.read("thr_b")).entries).toEqual([{ url: url(10), repo: "o/r", number: 10, facts: facts() }]);
  expect(host.bb.storage.database().prepare(`SELECT url FROM pull_requests ORDER BY url`).all()).toEqual([
    { url: url(10) },
  ]);
});

it("reads large logs a bounded number of pages per tick and carries on next tick", async () => {
  const noise = (seq: number): Event => ({ seq, type: "item/completed", data: { item: { type: "agentMessage" } } });
  const events = { thr_a: [...Array.from({ length: 2_049 }, (_, index) => noise(index + 1)), created(2_050, 10)] };
  const host = await mount({ events });
  keep(host.harness);
  host.harness.behavior.experimental_watchRpc("getPullRequests", { key: "thr_a" });
  await tick();
  expect(host.list).toHaveBeenCalledTimes(20);
  expect(await host.read()).toMatchObject({ scanned: true, entries: [] });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(host.list).toHaveBeenCalledTimes(21);
  expect((await host.read()).entries.map((entry) => entry.number)).toEqual([10]);
});
