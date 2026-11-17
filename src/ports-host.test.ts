import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

const mocks = vi.hoisted(() => ({ run: vi.fn(), platform: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.run }) };
});
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: mocks.platform,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  realpath: async (path: string) => path,
}));
import entry from "./ports-host";
import { resetTeaLoginsForTests } from "./pull-request-lookup";

const roots = [{ environmentId: "env_a", path: "/workspace/app" }];
const sockets = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
node 123 u 1u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)
node 456 u 1u IPv4 0x2 0t0 TCP 127.0.0.1:4000 (LISTEN)
`;
let harness: ReturnType<typeof experimental_createHostEntryHarness<typeof entry.contract, {}>>;

beforeEach(() => {
  mocks.run.mockReset();
  mocks.platform.mockReturnValue("darwin");
  resetTeaLoginsForTests();
  harness = experimental_createHostEntryHarness(entry);
});
afterEach(async () => {
  await harness.experimental_dispose();
});

function commands(docker: () => string = () => "") {
  mocks.run.mockImplementation(async (command: string, args: string[]) => {
    if (command === "lsof")
      return { stdout: args.includes("-d") ? "p123\nfcwd\nn/workspace/app\np456\nfcwd\nn/workspace/app\n" : sockets };
    if (command === "ps")
      return {
        stdout:
          args[0] === "eww"
            ? "node app.js BB_THREAD_ID=thr_owner PATH=/bin"
            : args.includes("lstart=")
              ? "Sat Oct  3 12:29:38 2026\n"
              : "123 node app.js\n456 node /opt/bb-app/server/dist/index.js",
      };
    if (command === "docker") return { stdout: docker() };
    throw new Error(`Unexpected command ${command}`);
  });
}

describe("host port scan", () => {
  it("reports the host timezone for provider reset timestamps", async () => {
    expect(await harness.experimental_call("timeZone", {})).toEqual({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("enriches process listeners with Docker metadata without losing ownership or bind address", async () => {
    commands(() => "abc\tapp-web-1\t0.0.0.0:3000->3000/tcp, 0.0.0.0:8080->8080/tcp\t/workspace/app\tweb");
    const result = await harness.experimental_call("scan", { roots });
    expect(result.ports).toEqual([
      {
        environmentId: "env_a",
        port: 3000,
        address: "127.0.0.1",
        pid: 123,
        processName: "node",
        source: "process",
        ownerThreadId: "thr_owner",
        processStartedAt: "Sat Oct  3 12:29:38 2026",
        container: "app-web-1",
        service: "web",
      },
      {
        environmentId: "env_a",
        port: 8080,
        address: "0.0.0.0",
        source: "docker",
        container: "app-web-1",
        service: "web",
      },
    ]);
  });

  it("keeps user listeners and excludes BB listeners when Docker is unavailable", async () => {
    commands(() => {
      throw new Error("ENOENT");
    });
    const result = await harness.experimental_call("scan", {
      roots: [...roots, { environmentId: "env_b", path: roots[0].path }],
    });
    expect(
      result.ports.map(({ environmentId, port, ownerThreadId }) => ({ environmentId, port, ownerThreadId })),
    ).toEqual([
      { environmentId: "env_a", port: 3000, ownerThreadId: "thr_owner" },
      { environmentId: "env_b", port: 3000, ownerThreadId: "thr_owner" },
    ]);
  });

  it("propagates cancellation instead of returning a partial scan", async () => {
    const controller = new AbortController();
    commands(() => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(harness.experimental_call("scan", { roots }, { signal: controller.signal })).rejects.toThrow();
  });
});

describe("host pull request lookup", () => {
  const ghView = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      number: 1,
      title: "Fix",
      state: "OPEN",
      isDraft: false,
      url: "https://github.com/o/r/pull/1",
      mergeable: "MERGEABLE",
      reviewDecision: "",
      statusCheckRollup: [{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" }],
      headRefName: "feature",
      baseRefName: "main",
      mergedAt: null,
      additions: 1,
      deletions: 0,
      ...overrides,
    });
  const logins = JSON.stringify([
    { name: "work", url: "https://git.example.com", ssh_host: "git.example.com", user: "me", default: "true" },
    { name: "other", url: "https://gitea.other.test/", ssh_host: "", user: "me" },
  ]);
  const pull = (overrides: Record<string, unknown> = {}) => ({
    title: "Fix",
    state: "open",
    merged: false,
    merged_at: null,
    draft: false,
    mergeable: true,
    additions: 3,
    deletions: 1,
    requested_reviewers: [],
    head: { ref: "feature", sha: "abc123" },
    base: { ref: "main" },
    ...overrides,
  });
  const found = (facts: Record<string, unknown>) =>
    expect.objectContaining({ outcome: "found", facts: expect.objectContaining(facts) });
  const teaCalls = () =>
    mocks.run.mock.calls.filter(([command]) => command === "tea").map(([, args]) => (args as string[]).join(" "));

  function tea(answers: Record<string, unknown | Error>) {
    mocks.run.mockImplementation(async (command: string, args: string[]) => {
      if (command === "tea" && args[0] === "logins") return { stdout: logins };
      if (command === "tea" && args[0] === "api") {
        const answer = answers[args[3]!];
        if (answer === undefined) throw new Error(`Unexpected tea api ${args[3]}`);
        if (answer instanceof Error) throw answer;
        return { stdout: JSON.stringify(answer) };
      }
      throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
    });
  }

  it("reads GitHub PRs with gh, on a PATH that reaches Homebrew and linuxbrew", async () => {
    mocks.run.mockImplementation(async (command: string, args: string[], options: { env: { PATH: string } }) => {
      expect(command).toBe("gh");
      expect(options.env.PATH.split(":")).toEqual(
        expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"]),
      );
      if (args[2]!.endsWith("/2"))
        throw Object.assign(new Error("gh failed"), { stderr: "Could not resolve to a PullRequest" });
      if (args[2]!.endsWith("/3")) throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      if (args[2]!.endsWith("/4"))
        throw Object.assign(new Error("gh failed"), {
          stderr: "To get started with GitHub CLI, please run: gh auth login",
        });
      return { stdout: ghView() };
    });
    const { pullRequests } = await harness.experimental_call("lookUpPullRequests", {
      urls: [1, 2, 3, 4].map((number) => `https://github.com/o/r/pull/${number}`),
    });
    expect(pullRequests).toEqual([
      found({ title: "Fix", state: "open", checks: { total: 1, passed: 1, pending: 0, failing: [] } }),
      { url: "https://github.com/o/r/pull/2", outcome: "failed", reason: "not_found" },
      { url: "https://github.com/o/r/pull/3", outcome: "failed", reason: "missing_tool" },
      { url: "https://github.com/o/r/pull/4", outcome: "failed", reason: "unauthorized" },
    ]);
    expect(mocks.run.mock.calls[0]?.[1]).toEqual([
      "pr",
      "view",
      "https://github.com/o/r/pull/1",
      "--json",
      "number,title,state,isDraft,url,mergeable,reviewDecision,statusCheckRollup,headRefName,baseRefName,mergedAt,additions,deletions",
    ]);
  });

  const statusPage = (statuses: Array<{ context: string; status: string }>, total = statuses.length) => ({
    state: statuses.some((entry) => entry.status === "failure") ? "failure" : "success",
    sha: "abc123",
    total_count: total,
    statuses,
  });
  const passing = (count: number, from = 1) =>
    Array.from({ length: count }, (_, index) => ({ context: `ci / step ${from + index}`, status: "success" }));
  const comments = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      state: "COMMENT",
      submitted_at: `2026-11-01T00:00:${String(index).padStart(2, "0")}Z`,
      user: { login: "lore-bot" },
    }));

  it("reads an open Gitea PR with three tea calls through the login for its origin", async () => {
    tea({
      "repos/o/r/pulls/5": pull({ requested_reviewers: [{ login: "reviewer" }] }),
      "repos/o/r/commits/abc123/status?limit=50&page=1": statusPage([
        { context: "ci / build", status: "success" },
        { context: "ci / test", status: "pending" },
      ]),
      "repos/o/r/pulls/5/reviews?limit=50&page=1": [],
    });
    const { pullRequests } = await harness.experimental_call("lookUpPullRequests", {
      urls: ["https://git.example.com/o/r/pulls/5"],
    });
    expect(pullRequests).toEqual([
      found({
        state: "open",
        checks: { total: 2, passed: 1, pending: 1, failing: [] },
        review: "review_requested",
        head: "feature",
        base: "main",
      }),
    ]);
    expect(teaCalls()).toEqual([
      "logins list --output json",
      "api --login work repos/o/r/pulls/5",
      "api --login work repos/o/r/commits/abc123/status?limit=50&page=1",
      "api --login work repos/o/r/pulls/5/reviews?limit=50&page=1",
    ]);
  });

  it("reads every page of statuses and reviews, so a failure or review past the first page counts", async () => {
    tea({
      "repos/o/r/pulls/5": pull(),
      // Gitea's own `state` on page one says success; the failure is on page two.
      "repos/o/r/commits/abc123/status?limit=50&page=1": statusPage(passing(50), 52),
      "repos/o/r/commits/abc123/status?limit=50&page=2": statusPage(
        [...passing(1, 51), { context: "ci / late", status: "failure" }],
        52,
      ),
      "repos/o/r/pulls/5/reviews?limit=50&page=1": comments(50),
      "repos/o/r/pulls/5/reviews?limit=50&page=2": [
        { id: 51, state: "REQUEST_CHANGES", submitted_at: "2026-11-02T00:00:00Z", user: { login: "ana" } },
      ],
    });
    const { pullRequests } = await harness.experimental_call("lookUpPullRequests", {
      urls: ["https://git.example.com/o/r/pulls/5"],
    });
    expect(pullRequests).toEqual([
      found({
        checks: { total: 52, passed: 51, pending: 0, failing: ["ci / late"] },
        review: "changes_requested",
      }),
    ]);
    expect(teaCalls().filter((call) => call.includes("page=3"))).toEqual([]);
  });

  it("fails the PR when a later page fails or the pages never end", async () => {
    tea({
      "repos/o/r/pulls/5": pull(),
      "repos/o/r/commits/abc123/status?limit=50&page=1": statusPage(passing(50), 60),
      "repos/o/r/commits/abc123/status?limit=50&page=2": Object.assign(new Error("tea failed"), {
        stderr: "connection reset",
      }),
      "repos/o/r/pulls/5/reviews?limit=50&page=1": [],
    });
    expect(
      (await harness.experimental_call("lookUpPullRequests", { urls: ["https://git.example.com/o/r/pulls/5"] }))
        .pullRequests,
    ).toEqual([{ url: "https://git.example.com/o/r/pulls/5", outcome: "failed", reason: "error" }]);

    mocks.run.mockReset();
    tea({
      "repos/o/r/pulls/6": pull(),
      "repos/o/r/commits/abc123/status?limit=50&page=1": statusPage([]),
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `repos/o/r/pulls/6/reviews?limit=50&page=${index + 1}`,
          comments(50),
        ]),
      ),
    });
    expect(
      (await harness.experimental_call("lookUpPullRequests", { urls: ["https://git.example.com/o/r/pulls/6"] }))
        .pullRequests,
    ).toEqual([{ url: "https://git.example.com/o/r/pulls/6", outcome: "failed", reason: "error" }]);
    expect(teaCalls().filter((call) => call.includes("/reviews?"))).toHaveLength(10);
  });

  it("spends one call on a merged PR and shares the login listing across a batch", async () => {
    tea({
      "repos/o/r/pulls/6": pull({ state: "closed", merged: true, merged_at: "2026-11-16T03:01:46Z" }),
      "repos/o/r/pulls/7": pull({ state: "closed" }),
    });
    const { pullRequests } = await harness.experimental_call("lookUpPullRequests", {
      urls: ["https://git.example.com/o/r/pulls/6", "https://git.example.com/o/r/pulls/7"],
    });
    expect(pullRequests).toEqual([
      found({ state: "merged", mergedAt: "2026-11-16T03:01:46Z", checks: null, review: null }),
      found({ state: "closed" }),
    ]);
    expect(teaCalls().filter((call) => call.startsWith("logins"))).toHaveLength(1);
    expect(teaCalls().filter((call) => call.startsWith("api"))).toHaveLength(2);
  });

  it("fails an open PR whose status or reviews call failed rather than describing half of it", async () => {
    tea({
      "repos/o/r/pulls/8": pull(),
      "repos/o/r/commits/abc123/status?limit=50&page=1": Object.assign(new Error("tea failed"), {
        stderr: "connection reset",
      }),
      "repos/o/r/pulls/8/reviews?limit=50&page=1": [],
    });
    const { pullRequests } = await harness.experimental_call("lookUpPullRequests", {
      urls: ["https://git.example.com/o/r/pulls/8"],
    });
    expect(pullRequests).toEqual([{ url: "https://git.example.com/o/r/pulls/8", outcome: "failed", reason: "error" }]);
  });

  it("fails an open PR whose head has no commit, instead of reading it without checks", async () => {
    tea({ "repos/o/r/pulls/8": pull({ head: { ref: "feature" } }) });
    const { pullRequests } = await harness.experimental_call("lookUpPullRequests", {
      urls: ["https://git.example.com/o/r/pulls/8"],
    });
    expect(pullRequests).toEqual([{ url: "https://git.example.com/o/r/pulls/8", outcome: "failed", reason: "error" }]);
    expect(teaCalls().filter((call) => call.startsWith("api"))).toEqual(["api --login work repos/o/r/pulls/8"]);
  });

  it("reads tea's HTTP error body as a failure, since tea exits 0 on one", async () => {
    tea({ "repos/o/r/pulls/9": { message: "not found", url: "https://git.example.com/api/swagger" } });
    const { pullRequests } = await harness.experimental_call("lookUpPullRequests", {
      urls: ["https://git.example.com/o/r/pulls/9"],
    });
    expect(pullRequests).toEqual([
      { url: "https://git.example.com/o/r/pulls/9", outcome: "failed", reason: "not_found" },
    ]);
  });

  it("never asks a login about a host it was not made for", async () => {
    tea({});
    const { pullRequests } = await harness.experimental_call("lookUpPullRequests", {
      urls: ["https://gitea.unknown.test/o/r/pulls/1"],
    });
    expect(pullRequests).toEqual([
      { url: "https://gitea.unknown.test/o/r/pulls/1", outcome: "failed", reason: "unauthorized" },
    ]);
    expect(teaCalls()).toEqual(["logins list --output json"]);
  });

  it("runs at most six commands at once", async () => {
    let running = 0;
    let peak = 0;
    mocks.run.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { stdout: ghView() };
    });
    const { pullRequests } = await harness.experimental_call("lookUpPullRequests", {
      urls: Array.from({ length: 12 }, (_, index) => `https://github.com/o/r/pull/${index + 1}`),
    });
    expect(pullRequests.filter((result) => result.outcome === "found")).toHaveLength(12);
    expect(peak).toBe(6);
  });

  it("propagates the caller's cancellation instead of answering", async () => {
    const controller = new AbortController();
    mocks.run.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    });
    await expect(
      harness.experimental_call(
        "lookUpPullRequests",
        { urls: ["https://github.com/o/r/pull/1"] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });
});
