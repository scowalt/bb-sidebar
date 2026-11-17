export interface PullRequestChecks {
  total: number;
  passed: number;
  pending: number;
  failing: string[];
}

export interface PullRequestFacts {
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  mergeable: boolean | null;
  checks: PullRequestChecks | null;
  review: "changes_requested" | "review_requested" | "approved" | null;
  head: string | null;
  base: string | null;
  mergedAt: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface PullRequestEntry {
  url: string;
  repo: string;
  number: number;
  facts: PullRequestFacts | null;
}

// Wire shapes stay mutable arrays: zod's input type is what the handler returns.
export interface ThreadPullRequests {
  entries: PullRequestEntry[];
  scanned: boolean;
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
  rank: number;
  tone: PullRequestTone;
  label: string;
  word: string;
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

export interface RailSegment {
  key: string;
  status: PullRequestStatus;
  span: number;
}

interface PullRequestSummary {
  total: number;
  merged: number;
  segments: readonly RailSegment[];
  worst: PullRequestStatus | null;
  rollup: readonly { status: PullRequestStatus; count: number }[];
}

export const MAX_RAIL_SEGMENTS = 16;

const byNumber = (a: PullRequestEntry, b: PullRequestEntry) => a.number - b.number;

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

export function rollupWords(summary: PullRequestSummary): string[] {
  return summary.rollup.map(({ status, count }) => `${count} ${PR_STATUS[status].word}`);
}

export function describePullRequests(summary: PullRequestSummary): string {
  const open = summary.rollup.filter(({ status }) => !isDone(status));
  const parts = [`${summary.merged} of ${summary.total} merged`, ...rollupWords({ ...summary, rollup: open })];
  return `Pull requests: ${parts.join(", ")}`;
}
