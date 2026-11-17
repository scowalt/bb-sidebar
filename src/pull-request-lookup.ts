import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PullRequestLookupResult } from "./port-scan-contract";
import { parseGhFacts, parseGiteaFacts, parsePullRequestUrl, type PullRequestIdentity } from "./pull-request-forges";
import type { PullRequestFacts } from "./pull-request-status";

const exec = promisify(execFile);

const COMMAND_TIMEOUT_MS = 8_000;
const OVERALL_DEADLINE_MS = 25_000;
const WORKERS = 6;
const LOGINS_TTL_MS = 5 * 60_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
// GUI-launched daemons often miss the shell PATH where Homebrew installs gh and tea.
const PATH = [
  process.env.PATH,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/home/linuxbrew/.linuxbrew/bin",
  join(homedir(), ".local/bin"),
]
  .filter(Boolean)
  .join(":");
const GH_FIELDS =
  "number,title,state,isDraft,url,mergeable,reviewDecision,statusCheckRollup,headRefName,baseRefName,mergedAt,additions,deletions";

type Failed = Extract<PullRequestLookupResult, { outcome: "failed" }>;

class LookupFailure extends Error {
  constructor(
    readonly reason: Failed["reason"],
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown) => (typeof value === "string" ? value : "");

function classifyCommandError(error: unknown, signal: AbortSignal): LookupFailure {
  const detail = isRecord(error) ? error : {};
  const output = `${text(detail.stderr)} ${text(detail.message)}`;
  if (signal.aborted || detail.killed === true || detail.code === "ABORT_ERR") {
    return new LookupFailure("timeout", "command timed out");
  }
  if (detail.code === "ENOENT") return new LookupFailure("missing_tool", output.trim());
  if (/not logged in|auth login|unauthori[sz]ed|\b401\b|\b403\b|token/i.test(output)) {
    return new LookupFailure("unauthorized", output.trim());
  }
  if (/could not resolve|not found|\b404\b/i.test(output)) return new LookupFailure("not_found", output.trim());
  return new LookupFailure("error", output.trim() || "command failed");
}

async function run(command: string, args: string[], signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await exec(command, args, {
      signal,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH },
    });
    return stdout;
  } catch (error) {
    throw classifyCommandError(error, signal);
  }
}

async function lookUpGitHub(url: string, signal: AbortSignal): Promise<PullRequestFacts> {
  const facts = parseGhFacts(await run("gh", ["pr", "view", url, "--json", GH_FIELDS], signal));
  if (!facts) throw new LookupFailure("error", "gh returned no pull request");
  return facts;
}

interface TeaLogin {
  name: string;
  origin: string;
}

let logins: { at: number; promise: Promise<TeaLogin[]> } | null = null;

function teaLogins(signal: AbortSignal): Promise<TeaLogin[]> {
  const now = Date.now();
  if (logins && now - logins.at < LOGINS_TTL_MS) return logins.promise;
  const promise = run("tea", ["logins", "list", "--output", "json"], signal).then((stdout) => {
    const parsed: unknown = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : []).flatMap((login) => {
      if (!isRecord(login) || typeof login.name !== "string" || typeof login.url !== "string") return [];
      try {
        return [{ name: login.name, origin: new URL(login.url).origin }];
      } catch {
        return [];
      }
    });
  });
  logins = { at: now, promise };
  promise.catch(() => {
    if (logins?.promise === promise) logins = null;
  });
  return promise;
}

export function resetTeaLoginsForTests() {
  logins = null;
}

/** `tea api` exits 0 on an HTTP error and prints Gitea's `{"message","url"}` body. */
function giteaError(value: unknown): LookupFailure | null {
  if (!isRecord(value) || typeof value.message !== "string" || typeof value.url !== "string") return null;
  if (Object.keys(value).length !== 2) return null;
  const message = value.message;
  if (/not found/i.test(message)) return new LookupFailure("not_found", message);
  if (/token|unauthori[sz]ed|forbidden|sign in/i.test(message)) return new LookupFailure("unauthorized", message);
  return new LookupFailure("error", message);
}

async function teaJson(login: string, path: string, signal: AbortSignal): Promise<unknown> {
  const stdout = await run("tea", ["api", "--login", login, path], signal);
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new LookupFailure("error", `tea api ${path} printed no JSON`);
  }
  const failure = giteaError(value);
  if (failure) throw failure;
  return value;
}

async function teaList(
  login: string,
  path: string,
  signal: AbortSignal,
  page: (value: unknown) => { items: unknown[]; total: number | null } | null,
): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let number = 1; number <= MAX_PAGES; number++) {
    const read = page(await teaJson(login, `${path}?limit=${PAGE_SIZE}&page=${number}`, signal));
    if (!read) throw new LookupFailure("error", `tea api ${path} printed no list`);
    items.push(...read.items);
    if (read.items.length < PAGE_SIZE || (read.total !== null && items.length >= read.total)) return items;
  }
  throw new LookupFailure("error", `tea api ${path} lists more than ${MAX_PAGES * PAGE_SIZE} entries`);
}

const statusPage = (value: unknown) =>
  isRecord(value) && Array.isArray(value.statuses)
    ? { items: value.statuses, total: typeof value.total_count === "number" ? value.total_count : null }
    : null;
const reviewPage = (value: unknown) => (Array.isArray(value) ? { items: value, total: null } : null);

async function lookUpGitea(identity: PullRequestIdentity, signal: AbortSignal): Promise<PullRequestFacts> {
  const login = (await teaLogins(signal)).find((candidate) => candidate.origin === identity.origin);
  if (!login) throw new LookupFailure("unauthorized", `no tea login for ${identity.origin}`);
  const base = `repos/${identity.repo}`;
  const pull = await teaJson(login.name, `${base}/pulls/${identity.number}`, signal);
  const detail = isRecord(pull) ? pull : {};
  const terminal = detail.merged === true || detail.state === "closed";
  const sha = isRecord(detail.head) && typeof detail.head.sha === "string" ? detail.head.sha : null;
  if (!terminal && !sha) throw new LookupFailure("error", "Gitea named no head commit for an open pull request");
  // The combined state is derived from every status, not read from a page's `state`.
  const [statuses, reviews] = terminal
    ? [null, null]
    : await Promise.all([
        teaList(login.name, `${base}/commits/${sha}/status`, signal, statusPage),
        teaList(login.name, `${base}/pulls/${identity.number}/reviews`, signal, reviewPage),
      ]);
  const facts = parseGiteaFacts(pull, statuses && { statuses }, reviews);
  if (!facts) throw new LookupFailure("error", "Gitea returned no pull request");
  return facts;
}

async function lookUpOne(url: string, signal: AbortSignal): Promise<PullRequestLookupResult> {
  const identity = parsePullRequestUrl(url);
  if (!identity) return { url, outcome: "failed", reason: "not_found" };
  try {
    const facts = identity.forge === "github" ? await lookUpGitHub(url, signal) : await lookUpGitea(identity, signal);
    return { url, outcome: "found", facts };
  } catch (error) {
    if (error instanceof LookupFailure) return { url, outcome: "failed", reason: error.reason };
    return { url, outcome: "failed", reason: "error" };
  }
}

export async function lookUpPullRequests(
  urls: readonly string[],
  signal: AbortSignal,
): Promise<PullRequestLookupResult[]> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(OVERALL_DEADLINE_MS)]);
  const results = new Map<string, PullRequestLookupResult>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(WORKERS, urls.length) }, async () => {
      while (next < urls.length && !deadline.aborted) {
        const url = urls[next++]!;
        results.set(url, await lookUpOne(url, deadline));
      }
    }),
  );
  signal.throwIfAborted();
  return urls.map((url) => results.get(url) ?? { url, outcome: "failed", reason: "timeout" });
}
