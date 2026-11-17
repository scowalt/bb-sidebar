import { describe, expect, it } from "vitest";
import {
  describePullRequests,
  MAX_RAIL_SEGMENTS,
  PR_STATUS,
  PR_STATUSES,
  pullRequestStatus,
  rollupWords,
  summarizePullRequests,
  type PullRequestEntry,
  type PullRequestFacts,
  type PullRequestStatus,
} from "./pull-request-status";

export function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
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

export function entry(number: number, value: Partial<PullRequestFacts> | null = {}, repo = "o/r"): PullRequestEntry {
  return {
    url: `https://git.example.com/${repo}/pulls/${number}`,
    repo,
    number,
    facts: value === null ? null : facts(value),
  };
}

describe("pullRequestStatus", () => {
  // One row per step of the derivation, each with the later steps' triggers
  // present too, so the order is what the test pins down.
  const cases: Array<[PullRequestStatus, Partial<PullRequestFacts> | null]> = [
    ["unknown", null],
    ["merged", { state: "merged", draft: true, checks: { total: 1, passed: 0, pending: 0, failing: ["ci"] } }],
    ["closed", { state: "closed", draft: true, mergeable: false }],
    ["draft", { draft: true, checks: { total: 1, passed: 0, pending: 0, failing: ["ci"] }, mergeable: false }],
    ["checks_failed", { checks: { total: 2, passed: 1, pending: 0, failing: ["ci"] }, mergeable: false }],
    ["conflicts", { mergeable: false, review: "changes_requested" }],
    ["changes_requested", { review: "changes_requested", checks: { total: 2, passed: 1, pending: 1, failing: [] } }],
    ["checks_pending", { checks: { total: 2, passed: 1, pending: 1, failing: [] }, review: "review_requested" }],
    ["review_requested", { review: "review_requested" }],
    ["ready", {}],
    ["ready", { review: "approved", checks: null, mergeable: null }],
  ];
  it.each(cases)("derives %s", (status, value) => {
    expect(pullRequestStatus(entry(1, value))).toBe(status);
  });

  it("ranks every status once, worst first, and marks merged and closed done", () => {
    expect(PR_STATUSES).toEqual([
      "checks_failed",
      "conflicts",
      "changes_requested",
      "checks_pending",
      "review_requested",
      "ready",
      "draft",
      "unknown",
      "merged",
      "closed",
    ]);
    expect(PR_STATUSES.filter((status) => PR_STATUS[status].done)).toEqual(["merged", "closed"]);
  });
});

describe("summarizePullRequests", () => {
  const merged = (number: number, mergedAt: string) => entry(number, { state: "merged", mergedAt });

  it("orders merged by merge time, then open work by repo and number, then closed", () => {
    const summary = summarizePullRequests([
      entry(9, { state: "closed" }),
      entry(7),
      merged(5, "2026-11-02T00:00:00Z"),
      entry(3, { checks: { total: 1, passed: 0, pending: 1, failing: [] } }, "o/a"),
      merged(2, "2026-11-01T00:00:00Z"),
      entry(8, { state: "closed" }),
    ]);
    expect(summary.segments.map((segment) => [segment.key.split("/").at(-1), segment.status, segment.span])).toEqual([
      ["2", "merged", 1],
      ["5", "merged", 1],
      ["3", "checks_pending", 1],
      ["7", "ready", 1],
      ["8", "closed", 1],
      ["9", "closed", 1],
    ]);
    expect(summary).toMatchObject({ total: 6, merged: 2, worst: "checks_pending" });
    expect(summary.rollup).toEqual([
      { status: "checks_pending", count: 1 },
      { status: "ready", count: 1 },
      { status: "merged", count: 2 },
      { status: "closed", count: 2 },
    ]);
    expect(rollupWords(summary)).toEqual(["1 running", "1 ready", "2 merged", "2 closed"]);
    expect(describePullRequests(summary)).toBe("Pull requests: 2 of 6 merged, 1 running, 1 ready");
  });

  it("has no worst status when everything is done", () => {
    const summary = summarizePullRequests([merged(1, "2026-11-01T00:00:00Z"), entry(2, { state: "closed" })]);
    expect(summary.worst).toBeNull();
    expect(describePullRequests(summary)).toBe("Pull requests: 1 of 2 merged");
  });

  it("treats a failed check with conflicts as failed, and lists the merged PR without facts as unknown", () => {
    const summary = summarizePullRequests([
      entry(1, { checks: { total: 1, passed: 0, pending: 0, failing: ["ci"] }, mergeable: false }),
      entry(2, null),
    ]);
    expect(summary.segments.map((segment) => segment.status)).toEqual(["checks_failed", "unknown"]);
    expect(summary.worst).toBe("checks_failed");
  });

  it("draws one segment per PR up to the limit, then merges runs of one tone", () => {
    const many = Array.from({ length: MAX_RAIL_SEGMENTS }, (_, index) =>
      merged(index + 1, `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00Z`),
    );
    expect(summarizePullRequests(many).segments).toHaveLength(MAX_RAIL_SEGMENTS);
    const summary = summarizePullRequests([
      ...many,
      entry(20, { checks: { total: 1, passed: 0, pending: 0, failing: ["ci"] } }),
      entry(21, { mergeable: false }),
      entry(22),
    ]);
    expect(summary.segments.map((segment) => [segment.status, segment.span])).toEqual([
      ["merged", MAX_RAIL_SEGMENTS],
      ["checks_failed", 2],
      ["ready", 1],
    ]);
    expect(summary.total).toBe(MAX_RAIL_SEGMENTS + 3);
  });
});
