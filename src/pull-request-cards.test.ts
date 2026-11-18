import { describe, expect, it } from "vitest";
import { pullRequestCard, pullRequestRef } from "./pull-request-cards";
import { entry } from "./pull-request-status.test";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const failing = { checks: { total: 19, passed: 18, pending: 0, failing: ["PR Format / format (pull_request)"] } };
const running = { checks: { total: 19, passed: 16, pending: 3, failing: [] } };

describe("pullRequestCard", () => {
  it("nests a PR under the one whose head is its base, in the same repo only", () => {
    const card = pullRequestCard(
      [
        entry(1, { head: "a", base: "main" }),
        entry(2, { head: "b", base: "a" }),
        entry(3, { head: "c", base: "b" }),
        entry(4, { head: "d", base: "a" }, "o/other"),
      ],
      NOW,
    );
    expect(card.rows.map((row) => [row.ref, row.depth])).toEqual([
      ["r#1", 0],
      ["r#2", 1],
      ["r#3", 2],
      ["other#4", 0],
    ]);
  });

  it("sorts roots by the worst status in their subtree", () => {
    const card = pullRequestCard(
      [
        entry(1, { head: "a", base: "main" }),
        entry(2, { head: "b", base: "main" }),
        entry(3, { head: "c", base: "b", ...failing }),
      ],
      NOW,
    );
    expect(card.rows.map((row) => row.ref)).toEqual(["#2", "#3", "#1"]);
  });

  it("lists every PR once when branch bases form a loop, with a root leading into it", () => {
    const card = pullRequestCard(
      [
        entry(1, { head: "main", base: "release" }),
        entry(2, { head: "feat", base: "main" }),
        entry(3, { head: "main", base: "feat" }),
        entry(4, { head: "hotfix", base: "release" }),
      ],
      NOW,
    );
    expect(card.rows.map((row) => [row.ref, row.depth])).toEqual([
      ["#1", 0],
      ["#2", 1],
      ["#3", 2],
      ["#4", 0],
    ]);
  });

  it("survives a release flow's back-merge and still sorts roots by their worst subtree", () => {
    const card = pullRequestCard(
      [
        entry(1, { head: "hotfix", base: "staging" }),
        entry(2, { head: "main", base: "staging" }),
        entry(3, { head: "main", base: "release", ...failing }),
        entry(4, { head: "release", base: "main" }),
      ],
      NOW,
    );
    expect(card.rows.map((row) => [row.ref, row.depth])).toEqual([
      ["#2", 0],
      ["#4", 1],
      ["#3", 2],
      ["#1", 0],
    ]);
  });

  it("folds three or more finished PRs behind one line while something is open", () => {
    const done = [
      entry(1, { state: "merged", mergedAt: "2026-11-10T00:00:00Z" }),
      entry(2, { state: "merged", mergedAt: "2026-11-12T00:00:00Z" }),
      entry(3, { state: "closed" }),
    ];
    const folded = pullRequestCard([...done, entry(4)], NOW);
    expect(folded.rows.map((row) => row.ref)).toEqual(["#4"]);
    expect(folded.folded?.label).toBe("Show 2 merged, 1 closed");
    expect(folded.folded?.rows.map((row) => row.ref)).toEqual(["#2", "#1", "#3"]);
    expect(folded).toMatchObject({ merged: 2, total: 4 });

    const allDone = pullRequestCard(done, NOW);
    expect(allDone.folded).toBeNull();
    expect(allDone.rows.map((row) => row.ref)).toEqual(["#2", "#1", "#3"]);

    const few = pullRequestCard([done[0]!, done[1]!, entry(4)], NOW);
    expect(few.folded).toBeNull();
    expect(few.rows.map((row) => row.ref)).toEqual(["#4", "#2", "#1"]);
  });

  it("gives a status that names itself one phrase in its tone, without repeating it", () => {
    const line = (value: Parameters<typeof entry>[1]) => pullRequestCard([entry(1, value)], NOW).rows[0]!.statusLine;
    const alone = (text: string, tone: string) => [{ text, tone, truncates: true }];
    expect(line(failing)).toEqual(alone("PR Format / format failed", "alert"));
    expect(line({ checks: { total: 3, passed: 0, pending: 0, failing: ["a", "b", "c"] } })).toEqual(
      alone("a and 2 more failed", "alert"),
    );
    expect(line(running)).toEqual(alone("3 of 19 checks running", "pending"));
    expect(line({ state: "merged", mergedAt: "2026-11-15T14:00:00Z" })).toEqual(alone("Merged 22h ago", "merged"));
    expect(line({ state: "merged", mergedAt: "2026-11-14T12:00:00Z" })).toEqual(alone("Merged 2d ago", "merged"));
    expect(line({ state: "merged", mergedAt: "2026-11-16T11:30:00Z" })).toEqual(alone("Merged 30m ago", "merged"));
    expect(line({ state: "merged", mergedAt: null })).toEqual(alone("Merged", "merged"));
    expect(line({ state: "closed" })).toEqual(alone("Closed", "closed"));
    expect(line(null)).toEqual(alone("Status unavailable", "unknown"));
  });

  it("leads any other open status with its uncut label, then the checks, which may be cut", () => {
    const line = (value: Parameters<typeof entry>[1]) => pullRequestCard([entry(1, value)], NOW).rows[0]!.statusLine;
    const labelled = (label: string, tone: string, checks: string) => [
      { text: label, tone, truncates: false },
      { text: checks, tone: null, truncates: true },
    ];
    expect(line({})).toEqual(labelled("Ready to merge", "ready", "3 checks passed"));
    expect(line({ checks: null })).toEqual(labelled("Ready to merge", "ready", "No checks"));
    expect(line({ mergeable: false })).toEqual(labelled("Conflicts", "alert", "3 checks passed"));
    expect(line({ review: "changes_requested" })).toEqual(labelled("Changes requested", "alert", "3 checks passed"));
    expect(line({ review: "review_requested" })).toEqual(labelled("Awaiting review", "review", "3 checks passed"));
    expect(line({ draft: true, ...failing })).toEqual(labelled("Draft", "draft", "PR Format / format failed"));
  });

  it("ends the line with conflicts beside a different status, and never on a finished PR", () => {
    const line = (value: Parameters<typeof entry>[1]) =>
      pullRequestCard([entry(1, value)], NOW).rows[0]!.statusLine.map(({ text, tone }) => [text, tone]);
    const conflicts = ["conflicts", "alert"];
    expect(line({ ...failing, mergeable: false })).toEqual([["PR Format / format failed", "alert"], conflicts]);
    expect(line({ review: "review_requested", mergeable: false })).toEqual([
      ["Conflicts", "alert"],
      ["3 checks passed", null],
    ]);
    expect(line({ ...running, review: "changes_requested", mergeable: false })).toEqual([
      ["Conflicts", "alert"],
      ["3 of 19 checks running", null],
    ]);
    expect(line({ draft: true, mergeable: false })).toEqual([["Draft", "draft"], ["3 checks passed", null], conflicts]);
    expect(line({ state: "merged", mergedAt: null, mergeable: false })).toEqual([["Merged", "merged"]]);
  });
});

describe("pullRequestRef", () => {
  it("drops the repo while every PR shares one, and shortens internal-tool names otherwise", () => {
    const one = [entry(1), entry(2)];
    expect(pullRequestRef(one[0]!, one)).toBe("#1");
    const mixed = [entry(1, {}, "wonderlydotcom/internal-tool-csm-ops"), entry(2, {}, "wonderlydotcom/backend-net")];
    expect(mixed.map((item) => pullRequestRef(item, mixed))).toEqual(["csm-ops#1", "backend-net#2"]);
  });
});
