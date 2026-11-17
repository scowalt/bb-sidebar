// A thread's pull requests as the server stores them, the wire carries them,
// and the app draws them. The wire carries facts, never a status: this module
// holds the one derivation and the one table every surface reads.

export interface PullRequestChecks {
  total: number;
  passed: number;
  pending: number;
  /** Names of the checks that failed or errored, in the forge's order. */
  failing: string[];
}

/**
 * What a forge says about one PR, in forge-neutral terms. Never partial: a
 * host that cannot fill every field reports the PR as failed, and its entry
 * keeps the facts it had.
 */
export interface PullRequestFacts {
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** null: the forge has not computed it yet. Meaningless once merged. */
  mergeable: boolean | null;
  /** null: no CI reported on the head commit. */
  checks: PullRequestChecks | null;
  /** The latest review per reviewer, reduced, plus pending requests. */
  review: "changes_requested" | "review_requested" | "approved" | null;
  head: string | null;
  base: string | null;
  mergedAt: string | null;
  additions: number | null;
  deletions: number | null;
}

/** One PR of a thread. Identity is the URL. */
export interface PullRequestEntry {
  /** Canonical: https://host/owner/repo/pulls/N or …/pull/N. */
  url: string;
  /** "owner/repo" */
  repo: string;
  number: number;
  /** null until the first successful lookup, or forever if no host can read it. */
  facts: PullRequestFacts | null;
}

// Wire shapes stay mutable arrays: zod's input type is what the handler returns.
export interface ThreadPullRequests {
  /** In discovery order: the order the thread opened them. */
  entries: PullRequestEntry[];
  /** False until the thread's log has been scanned once. */
  scanned: boolean;
  /** The latest scan attempt failed; the server tries again while the thread is watched. */
  scanFailed: boolean;
}

export type PullRequestStatus =
  | "checks_failed"
  | "conflicts"
  | "changes_requested"
  | "checks_pending"
  | "review_requested"
  | "ready"
  | "draft"
  | "unknown"
  | "merged"
  | "closed";

export type PullRequestTone = "alert" | "pending" | "review" | "ready" | "draft" | "unknown" | "merged" | "closed";

interface StatusRow {
  /** Worst first. */
  rank: number;
  tone: PullRequestTone;
  label: string;
  /** The rollup's noun phrase: "2 failing". */
  word: string;
  /** Merged and closed: never looked up again, never "open work". */
  done: boolean;
}

export const PR_STATUS = {
  checks_failed: { rank: 0, tone: "alert", label: "Checks failed", word: "failing", done: false },
  conflicts: { rank: 1, tone: "alert", label: "Conflicts", word: "conflicting", done: false },
  changes_requested: { rank: 2, tone: "alert", label: "Changes requested", word: "changes requested", done: false },
  checks_pending: { rank: 3, tone: "pending", label: "Checks running", word: "running", done: false },
  review_requested: { rank: 4, tone: "review", label: "Awaiting review", word: "in review", done: false },
  ready: { rank: 5, tone: "ready", label: "Ready to merge", word: "ready", done: false },
  draft: { rank: 6, tone: "draft", label: "Draft", word: "draft", done: false },
  unknown: { rank: 7, tone: "unknown", label: "Status unavailable", word: "unknown", done: false },
  merged: { rank: 8, tone: "merged", label: "Merged", word: "merged", done: true },
  closed: { rank: 9, tone: "closed", label: "Closed", word: "closed", done: true },
} as const satisfies Record<PullRequestStatus, StatusRow>;

/** Every status, worst first. */
export const PR_STATUSES = (Object.keys(PR_STATUS) as PullRequestStatus[]).sort(
  (a, b) => PR_STATUS[a].rank - PR_STATUS[b].rank,
);

export function pullRequestStatus(entry: PullRequestEntry): PullRequestStatus {
  const facts = entry.facts;
  if (!facts) return "unknown";
  if (facts.state === "merged") return "merged";
  if (facts.state === "closed") return "closed";
  if (facts.draft) return "draft";
  if (facts.checks && facts.checks.failing.length > 0) return "checks_failed";
  if (facts.mergeable === false) return "conflicts";
  if (facts.review === "changes_requested") return "changes_requested";
  if (facts.checks && facts.checks.pending > 0) return "checks_pending";
  if (facts.review === "review_requested") return "review_requested";
  return "ready";
}

export function isDone(status: PullRequestStatus): boolean {
  return PR_STATUS[status].done;
}

/** One drawn segment of the rail. Past MAX_RAIL_SEGMENTS, a run of one tone draws as one segment. */
export interface RailSegment {
  /** The first PR's URL in the run. */
  key: string;
  status: PullRequestStatus;
  /** How many PRs the segment stands for; its share of the rail's width. */
  span: number;
}

interface PullRequestSummary {
  total: number;
  merged: number;
  /** Rail order: merged by merge time, then open work by repo and number, then closed by number. */
  segments: readonly RailSegment[];
  /** The worst status among PRs that are not done; null when everything is done. */
  worst: PullRequestStatus | null;
  /** Open statuses in rank order, then merged, then closed: "2 failing · 1 running · 3 merged". */
  rollup: readonly { status: PullRequestStatus; count: number }[];
}

/** Beyond this many PRs the rail would draw sub-pixel slivers. */
export const MAX_RAIL_SEGMENTS = 16;

const byNumber = (a: PullRequestEntry, b: PullRequestEntry) => a.number - b.number;

/** Rail order, each entry with its status. */
export function orderPullRequests(
  entries: readonly PullRequestEntry[],
): { entry: PullRequestEntry; status: PullRequestStatus }[] {
  const merged = entries.filter((entry) => pullRequestStatus(entry) === "merged");
  const closed = entries.filter((entry) => pullRequestStatus(entry) === "closed");
  const open = entries.filter((entry) => !isDone(pullRequestStatus(entry)));
  merged.sort((a, b) => (a.facts?.mergedAt ?? "").localeCompare(b.facts?.mergedAt ?? "") || byNumber(a, b));
  open.sort((a, b) => a.repo.localeCompare(b.repo) || byNumber(a, b));
  closed.sort(byNumber);
  return [...merged, ...open, ...closed].map((entry) => ({ entry, status: pullRequestStatus(entry) }));
}

export function summarizePullRequests(entries: readonly PullRequestEntry[]): PullRequestSummary {
  const ordered = orderPullRequests(entries);
  const counts = new Map<PullRequestStatus, number>();
  for (const { status } of ordered) counts.set(status, (counts.get(status) ?? 0) + 1);
  const rollup = PR_STATUSES.flatMap((status) => {
    const count = counts.get(status) ?? 0;
    return count ? [{ status, count }] : [];
  });
  const worst = PR_STATUSES.find((status) => !isDone(status) && counts.has(status)) ?? null;
  const segments: RailSegment[] = [];
  const coalesce = ordered.length > MAX_RAIL_SEGMENTS;
  for (const { entry, status } of ordered) {
    const last = segments.at(-1);
    if (coalesce && last && PR_STATUS[last.status].tone === PR_STATUS[status].tone) last.span += 1;
    else segments.push({ key: entry.url, status, span: 1 });
  }
  return { total: ordered.length, merged: counts.get("merged") ?? 0, segments, worst, rollup };
}

/** The rollup in words: "2 failing · 1 running · 3 merged". */
export function rollupWords(summary: PullRequestSummary): string[] {
  return summary.rollup.map(({ status, count }) => `${count} ${PR_STATUS[status].word}`);
}

/** The rail's accessible name: "Pull requests: 2 of 4 merged, 1 failing, 1 running". */
export function describePullRequests(summary: PullRequestSummary): string {
  const open = summary.rollup.filter(({ status }) => !isDone(status));
  const parts = [`${summary.merged} of ${summary.total} merged`, ...rollupWords({ ...summary, rollup: open })];
  return `Pull requests: ${parts.join(", ")}`;
}
