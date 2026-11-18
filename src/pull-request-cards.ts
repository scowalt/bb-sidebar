import {
  isDone,
  PR_STATUS,
  pullRequestStatus,
  type PullRequestChecks,
  type PullRequestEntry,
  type PullRequestStatus,
  type PullRequestTone,
} from "./pull-request-status";

/** One phrase of a card row's status line; a null tone is the card's muted text. */
interface StatusPhrase {
  text: string;
  tone: PullRequestTone | null;
  truncates: boolean;
}

export interface PullRequestCardRow {
  entry: PullRequestEntry;
  status: PullRequestStatus;
  depth: number;
  ref: string;
  /** Phrases shown in order, joined by a muted dot. */
  statusLine: readonly StatusPhrase[];
}

interface PullRequestCard {
  merged: number;
  total: number;
  rows: readonly PullRequestCardRow[];
  folded: { label: string; rows: readonly PullRequestCardRow[] } | null;
}

const FOLD_AT = 3;

const shortRepo = (repo: string) => (repo.split("/")[1] ?? repo).replace(/^internal-tools?-/, "");

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

function checksPhrase(checks: PullRequestChecks | null): string {
  if (!checks || checks.total === 0) return "No checks";
  if (checks.failing.length) {
    const first = checks.failing[0]!.replace(/ \(pull_request\)$/, "");
    const more = checks.failing.length - 1;
    return more ? `${first} and ${more} more failed` : `${first} failed`;
  }
  if (checks.pending) return `${checks.pending} of ${checks.total} checks running`;
  return `${checks.total} checks passed`;
}

/**
 * The status line under a row's title. A status that names itself (failed or
 * running checks, merged, closed, unknown) is one phrase in its tone; any
 * other open status leads with its label, then the checks. Conflicts beside a
 * different status come last.
 */
function statusLine(entry: PullRequestEntry, status: PullRequestStatus, now: number): StatusPhrase[] {
  const line = statusPhrases(entry, status, now);
  const alsoConflicts = !isDone(status) && status !== "conflicts" && entry.facts?.mergeable === false;
  return alsoConflicts ? [...line, { text: "conflicts", tone: "alert", truncates: false }] : line;
}

function statusPhrases(entry: PullRequestEntry, status: PullRequestStatus, now: number): StatusPhrase[] {
  const tone = PR_STATUS[status].tone;
  const facts = entry.facts;
  const alone = (text: string): StatusPhrase[] => [{ text, tone, truncates: true }];
  switch (status) {
    case "unknown":
    case "closed":
      return alone(PR_STATUS[status].label);
    case "merged":
      return alone(facts?.mergedAt ? `Merged ${ago(facts.mergedAt, now)} ago` : "Merged");
    case "checks_failed":
    case "checks_pending":
      return alone(checksPhrase(facts?.checks ?? null));
    case "conflicts":
    case "changes_requested":
    case "review_requested":
    case "ready":
    case "draft":
      return [
        { text: PR_STATUS[status].label, tone, truncates: false },
        { text: checksPhrase(facts?.checks ?? null), tone: null, truncates: true },
      ];
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function pullRequestCard(entries: readonly PullRequestEntry[], now: number): PullRequestCard {
  const row = (entry: PullRequestEntry, depth: number): PullRequestCardRow => {
    const status = pullRequestStatus(entry);
    return {
      entry,
      status,
      depth,
      ref: pullRequestRef(entry, entries),
      statusLine: statusLine(entry, status, now),
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
  const rootlessLoops = () => {
    for (const entry of open) walk(entry, 0);
  };
  for (const root of roots) walk(root, 0);
  rootlessLoops();
  const doneRows = done.map((entry) => row(entry, 0));
  const merged = done.filter((entry) => pullRequestStatus(entry) === "merged").length;
  const closed = done.length - merged;
  if (open.length && done.length >= FOLD_AT) {
    const words = [merged && `${merged} merged`, closed && `${closed} closed`].filter(Boolean).join(", ");
    return { merged, total: entries.length, rows, folded: { label: `Show ${words}`, rows: doneRows } };
  }
  return { merged, total: entries.length, rows: [...rows, ...doneRows], folded: null };
}
