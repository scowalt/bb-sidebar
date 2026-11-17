// What the forges print and answer: PR URLs in a thread's command log, and
// the JSON `gh pr view` and `tea api` return. Pure, so fixtures test it
// without spawning anything.
import type { PullRequestChecks, PullRequestFacts } from "./pull-request-status";

export type Forge = "github" | "gitea";

export interface PullRequestIdentity {
  forge: Forge;
  origin: string;
  /** "owner/repo" as printed. */
  repo: string;
  number: number;
}

const PULL_REQUEST_URL = /^(https?:\/\/[\w.-]+(?::\d+)?)\/([\w.-]+\/[\w.-]+)\/pulls?\/(\d+)$/;

/** github.com is GitHub; every other origin is a Gitea the host has a `tea` login for. */
export function parsePullRequestUrl(url: string): PullRequestIdentity | null {
  const match = PULL_REQUEST_URL.exec(url);
  if (!match) return null;
  const [, origin, repo, number] = match;
  return {
    forge: new URL(origin!).hostname === "github.com" ? "github" : "gitea",
    origin: origin!,
    repo: repo!,
    number: Number(number),
  };
}

// A command runs at the start, after a shell separator, a `{` or a `do`, or
// as the script of a `zsh -lc "…"` wrapper (how Codex records commands),
// with optional `VAR=x`, `timeout 60` and path prefixes. Mentions inside
// quotes or prose, like a grep for the phrase, do not count.
const ANCHOR =
  String.raw`(?:^(?:[\w./-]*\/)?(?:ba|z)?sh\s+-[a-z]*c\s+["']|^|[\n;&|({]|\b(?:do|then|else)\s)\s*` +
  String.raw`(?:\w+=\S*\s+)*(?:(?:timeout|nice|nohup|command|exec)\s+(?:-\S+\s+)*(?:\d+[smh]?\s+)?)?(?:[\w./-]*\/)?`;
// The rest of the command up to the next separator: where its options are.
const REST = String.raw`([^\n;&|]*)`;
const GH_CREATE = new RegExp(`${ANCHOR}gh\\s+pr\\s+create\\b${REST}`, "g");
const TEA_CREATE = new RegExp(`${ANCHOR}tea\\s+(?:pr|pulls?)\\s+(?:create|c)\\b${REST}`, "g");
const TEA_API = new RegExp(`${ANCHOR}tea\\s+api\\b${REST}`, "g");
const REPO_OPTION = /(?:^|\s)(?:--repo|-[Rr])[\s=]+["']?([\w.-]+\/[\w.-]+)/;
const API_METHOD = /(?:^|\s)(?:-X|--method)[\s=]*["']?(POST|PATCH)\b/;
// `repos/o/r/pulls`, `repos/o/$1/pulls` or `$R/pulls/$n`: the segments may be
// shell variables, which name no repo. Ends at a quote, a space, or the end,
// so `/pulls/12/merge` and `/pulls/12/reviews` never count as writing a PR.
const API_PULLS_PATH = /(?:repos\/([^\s"'/]+\/[^\s"'/]+)|\$\{?\w+\}?)\/pulls(?:\/([^\s"'/]+))?(?=["'\s]|$)/;
const isLiteral = (segment: string | undefined): segment is string => segment !== undefined && !segment.includes("$");
// Split Pi's doubled OSC 8 output, `…/pulls/16575https://…/pulls/16575`, into
// two matches: no trailing anchor.
const OUTPUT_URL = /https?:\/\/[\w.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+\/pulls?\/\d+/g;

type Acceptance = (identity: PullRequestIdentity) => boolean;

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What PRs each PR-writing command in `command` may have printed. A command
 * that names its repo (`--repo o/r`, `-R o/r`, or an API path) vouches only
 * for that repo; a PATCH of one PR vouches only for it.
 */
function acceptances(command: string): Acceptance[] {
  const accepted: Acceptance[] = [];
  const byRepoOption = (rest: string): Acceptance => {
    const repo = REPO_OPTION.exec(rest)?.[1];
    return repo ? (identity) => sameRepo(identity.repo, repo) : () => true;
  };
  for (const [, rest] of command.matchAll(GH_CREATE)) accepted.push(byRepoOption(rest!));
  for (const [, rest] of command.matchAll(TEA_CREATE)) accepted.push(byRepoOption(rest!));
  for (const [, rest] of command.matchAll(TEA_API)) {
    const method = API_METHOD.exec(rest!)?.[1];
    const path = API_PULLS_PATH.exec(rest!);
    if (!method || !path) continue;
    const [, repo, number] = path;
    if (!isLiteral(repo)) accepted.push(() => true);
    else if (method === "PATCH" && isLiteral(number)) {
      accepted.push((identity) => sameRepo(identity.repo, repo) && identity.number === Number(number));
    } else accepted.push((identity) => sameRepo(identity.repo, repo));
  }
  return accepted;
}

/**
 * PR URLs printed by commands that write a PR (`gh pr create`, `tea pr
 * create`, `tea api -X POST|PATCH …/pulls[/N]`), oldest first, deduped. A
 * failed create that reports "a pull request already exists" names the
 * thread's PR too, so the command status is not checked.
 */
export function createdPullRequestUrls(events: readonly { type: string; data: unknown }[]): string[] {
  const urls = new Set<string>();
  for (const event of events) {
    if (event.type !== "item/completed") continue;
    const item = (event.data as { item?: unknown } | null)?.item as
      | { type?: unknown; command?: unknown; aggregatedOutput?: unknown }
      | undefined;
    if (item?.type !== "commandExecution") continue;
    if (typeof item.command !== "string" || typeof item.aggregatedOutput !== "string") continue;
    const accepted = acceptances(item.command);
    if (!accepted.length) continue;
    for (const [url] of item.aggregatedOutput.matchAll(OUTPUT_URL)) {
      const identity = parsePullRequestUrl(url);
      if (identity && accepted.some((accepts) => accepts(identity))) urls.add(url);
    }
  }
  return [...urls];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const string = (value: unknown) => (typeof value === "string" ? value : null);
const integer = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : null);

/**
 * `gh pr view <url> --json number,title,state,isDraft,url,mergeable,reviewDecision,statusCheckRollup,headRefName,baseRefName,mergedAt,additions,deletions`.
 * Null when the JSON does not describe a PR.
 */
export function parseGhFacts(stdout: string): PullRequestFacts | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.title !== "string") return null;
  const state =
    value.state === "MERGED" ? "merged" : value.state === "CLOSED" ? "closed" : value.state === "OPEN" ? "open" : null;
  if (!state) return null;
  const rollup = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [];
  const review =
    value.reviewDecision === "CHANGES_REQUESTED"
      ? "changes_requested"
      : value.reviewDecision === "REVIEW_REQUIRED"
        ? "review_requested"
        : value.reviewDecision === "APPROVED"
          ? "approved"
          : null;
  return {
    title: value.title,
    state,
    draft: value.isDraft === true,
    mergeable: value.mergeable === "MERGEABLE" ? true : value.mergeable === "CONFLICTING" ? false : null,
    checks: rollup.length ? reduceChecks(rollup.map(ghCheck)) : null,
    review,
    head: string(value.headRefName),
    base: string(value.baseRefName),
    mergedAt: string(value.mergedAt),
    additions: integer(value.additions),
    deletions: integer(value.deletions),
  };
}

type CheckOutcome = { name: string; outcome: "passed" | "pending" | "failing" };

const GH_FAILING = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "CANCELLED", "ERROR"]);

/** A CheckRun (`status` + `conclusion`) or a StatusContext (`state`). */
function ghCheck(entry: unknown): CheckOutcome {
  const check = isRecord(entry) ? entry : {};
  const name = string(check.name) ?? string(check.context) ?? "check";
  if (typeof check.state === "string") {
    const state = check.state;
    return { name, outcome: GH_FAILING.has(state) ? "failing" : state === "SUCCESS" ? "passed" : "pending" };
  }
  if (check.status !== "COMPLETED") return { name, outcome: "pending" };
  return { name, outcome: GH_FAILING.has(String(check.conclusion)) ? "failing" : "passed" };
}

function reduceChecks(checks: readonly CheckOutcome[]): PullRequestChecks {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.outcome === "passed").length,
    pending: checks.filter((check) => check.outcome === "pending").length,
    failing: checks.filter((check) => check.outcome === "failing").map((check) => check.name),
  };
}

/**
 * `tea api repos/o/r/pulls/N`, with the head commit's combined status
 * (`…/commits/<sha>/status`) and the PR's reviews (`…/pulls/N/reviews`).
 * Both are null for a merged or closed PR, which needs neither. Null when the
 * pull does not describe a PR.
 */
export function parseGiteaFacts(pull: unknown, status: unknown, reviews: unknown): PullRequestFacts | null {
  if (!isRecord(pull) || typeof pull.title !== "string") return null;
  const head = isRecord(pull.head) ? pull.head : {};
  const base = isRecord(pull.base) ? pull.base : {};
  const state =
    pull.merged === true ? "merged" : pull.state === "closed" ? "closed" : pull.state === "open" ? "open" : null;
  if (!state) return null;
  const requested = Array.isArray(pull.requested_reviewers) && pull.requested_reviewers.length > 0;
  return {
    title: pull.title,
    state,
    draft: pull.draft === true,
    mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : null,
    checks: giteaChecks(status),
    review: giteaReview(reviews, requested),
    head: string(head.ref),
    base: string(base.ref),
    mergedAt: string(pull.merged_at),
    additions: integer(pull.additions),
    deletions: integer(pull.deletions),
  };
}

/** Gitea's combined status: `total_count` 0 means no CI reported, which is not a failure. */
function giteaChecks(status: unknown): PullRequestChecks | null {
  if (!isRecord(status) || !Array.isArray(status.statuses) || status.statuses.length === 0) return null;
  return reduceChecks(
    status.statuses.map((entry) => {
      const check = isRecord(entry) ? entry : {};
      const state = string(check.status);
      return {
        name: string(check.context) ?? "check",
        outcome: state === "failure" || state === "error" ? "failing" : state === "pending" ? "pending" : "passed",
      };
    }),
  );
}

/** The latest review per reviewer wins; dismissed ones and comments say nothing. */
function giteaReview(reviews: unknown, requested: boolean): PullRequestFacts["review"] {
  const latest = new Map<string, { state: string; at: string }>();
  for (const entry of Array.isArray(reviews) ? reviews : []) {
    if (!isRecord(entry) || entry.dismissed === true) continue;
    const state = string(entry.state);
    if (state !== "APPROVED" && state !== "REQUEST_CHANGES" && state !== "REQUEST_REVIEW") continue;
    const user = isRecord(entry.user) ? (string(entry.user.login) ?? String(entry.user.id)) : String(entry.id);
    const at = string(entry.submitted_at) ?? "";
    const previous = latest.get(user);
    if (!previous || previous.at <= at) latest.set(user, { state, at });
  }
  const states = new Set([...latest.values()].map((review) => review.state));
  if (states.has("REQUEST_CHANGES")) return "changes_requested";
  if (states.has("REQUEST_REVIEW") || requested) return "review_requested";
  if (states.has("APPROVED")) return "approved";
  return null;
}
