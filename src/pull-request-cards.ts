// The hover card's "List + stacks" model: open work first as stack trees,
// finished PRs after, folded when there is enough of both.
import {
  isDone,
  PR_STATUS,
  pullRequestStatus,
  type PullRequestEntry,
  type PullRequestStatus,
} from "./pull-request-status";

export interface PullRequestCardRow {
  entry: PullRequestEntry;
  status: PullRequestStatus;
  /** 0 for a root; n under the PR whose head branch is this PR's base, in the same repo. */
  depth: number;
  /** "#12" when every entry shares one repo, else "csm-ops#12". */
  ref: string;
  /** The second line: a failing check's name, running or passed counts, when it merged, or "closed". */
  detail: string;
  /** Conflicts beside a different headline status: failing checks plus conflicts, say. */
  alsoConflicts: boolean;
}

interface PullRequestCard {
  merged: number;
  total: number;
  /** Open work as stack trees, worst root first, then the finished rows unless folded. */
  rows: readonly PullRequestCardRow[];
  /** With open work and three or more finished PRs, the finished rows fold behind "Show 3 merged, 1 closed". */
  folded: { label: string; rows: readonly PullRequestCardRow[] } | null;
}

/** Finished PRs fold only when there are at least this many and something is still open. */
const FOLD_AT = 3;

const shortRepo = (repo: string) => (repo.split("/")[1] ?? repo).replace(/^internal-tools?-/, "");

/** "#12" among one repo, "csm-ops#12" among several. */
export function pullRequestRef(entry: PullRequestEntry, entries: readonly PullRequestEntry[]): string {
  const oneRepo = entries.every((other) => other.repo.toLowerCase() === entry.repo.toLowerCase());
  return oneRepo ? `#${entry.number}` : `${shortRepo(entry.repo)}#${entry.number}`;
}

function ago(iso: string, now: number): string {
  const minutes = Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function detailOf(entry: PullRequestEntry, status: PullRequestStatus, now: number): string {
  const facts = entry.facts;
  if (!facts) return "Status unavailable";
  if (status === "merged") return facts.mergedAt ? `merged ${ago(facts.mergedAt, now)} ago` : "merged";
  if (status === "closed") return "closed";
  const checks = facts.checks;
  if (!checks || checks.total === 0) return "No checks";
  if (checks.failing.length) {
    const first = checks.failing[0]!.replace(/ \(pull_request\)$/, "");
    const more = checks.failing.length - 1;
    return more ? `${first} and ${more} more failed` : `${first} failed`;
  }
  if (checks.pending) return `${checks.pending} of ${checks.total} checks running`;
  return `${checks.total} checks passed`;
}

export function pullRequestCard(entries: readonly PullRequestEntry[], now: number): PullRequestCard {
  const row = (entry: PullRequestEntry, depth: number): PullRequestCardRow => {
    const status = pullRequestStatus(entry);
    return {
      entry,
      status,
      depth,
      ref: pullRequestRef(entry, entries),
      detail: detailOf(entry, status, now),
      alsoConflicts: !isDone(status) && status !== "conflicts" && entry.facts?.mergeable === false,
    };
  };
  const open = entries.filter((entry) => !isDone(pullRequestStatus(entry)));
  const done = entries
    .filter((entry) => isDone(pullRequestStatus(entry)))
    .sort(
      (a, b) =>
        (b.facts?.mergedAt ?? "").localeCompare(a.facts?.mergedAt ?? "") ||
        PR_STATUS[pullRequestStatus(a)].rank - PR_STATUS[pullRequestStatus(b)].rank ||
        b.number - a.number,
    );
  const branchKey = (repo: string, branch: string | null) => `${repo.toLowerCase()}@${branch}`;
  const heads = new Set(
    open.filter((entry) => entry.facts?.head).map((entry) => branchKey(entry.repo, entry.facts!.head)),
  );
  const children = (parent: PullRequestEntry) =>
    open
      .filter(
        (child) =>
          child !== parent &&
          parent.facts?.head &&
          child.facts?.base &&
          branchKey(child.repo, child.facts.base) === branchKey(parent.repo, parent.facts.head),
      )
      .sort((a, b) => a.number - b.number);
  // Bases can loop (a release back-merge), so every walk remembers where it has been.
  const worst = (root: PullRequestEntry): number => {
    let rank = Number.POSITIVE_INFINITY;
    const visited = new Set<PullRequestEntry>();
    const pending = [root];
    for (let entry = pending.pop(); entry; entry = pending.pop()) {
      if (visited.has(entry)) continue;
      visited.add(entry);
      rank = Math.min(rank, PR_STATUS[pullRequestStatus(entry)].rank);
      pending.push(...children(entry));
    }
    return rank;
  };
  const roots = open
    .filter((entry) => !entry.facts?.base || !heads.has(branchKey(entry.repo, entry.facts.base)))
    .sort((a, b) => worst(a) - worst(b) || a.number - b.number);
  const rows: PullRequestCardRow[] = [];
  const seen = new Set<PullRequestEntry>();
  const walk = (entry: PullRequestEntry, depth: number) => {
    if (seen.has(entry)) return;
    seen.add(entry);
    rows.push(row(entry, depth));
    for (const child of children(entry)) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // A loop of bases with no way in has no root; list what the walk missed as roots.
  for (const entry of open) walk(entry, 0);
  const doneRows = done.map((entry) => row(entry, 0));
  const merged = done.filter((entry) => pullRequestStatus(entry) === "merged").length;
  const closed = done.length - merged;
  if (open.length && done.length >= FOLD_AT) {
    const words = [merged && `${merged} merged`, closed && `${closed} closed`].filter(Boolean).join(", ");
    return { merged, total: entries.length, rows, folded: { label: `Show ${words}`, rows: doneRows } };
  }
  return { merged, total: entries.length, rows: [...rows, ...doneRows], folded: null };
}
