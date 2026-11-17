// Runs `gh` and `tea` where the thread's workspace, and so its sign-in,
// lives. Every URL gets an answer: found with every fact, or failed with a
// reason, never a PR described by half its facts.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PullRequestLookupResult } from "./port-scan-contract";
import { parseGhFacts, parseGiteaFacts, parsePullRequestUrl, type PullRequestIdentity } from "./pull-request-forges";
import type { PullRequestFacts } from "./pull-request-status";

const exec = promisify(execFile);

const COMMAND_TIMEOUT_MS = 8_000;
/** The server's call allows 30 s; answer before it gives up on the whole batch. */
const OVERALL_DEADLINE_MS = 25_000;
const WORKERS = 6;
const LOGINS_TTL_MS = 5 * 60_000;
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

/** `tea logins list --output json`, cached a few minutes per process. */
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
  // A failed listing is asked again next time rather than cached.
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

async function lookUpGitea(identity: PullRequestIdentity, signal: AbortSignal): Promise<PullRequestFacts> {
  const login = (await teaLogins(signal)).find((candidate) => candidate.origin === identity.origin);
  // Never ask the default login about a host it was not made for.
  if (!login) throw new LookupFailure("unauthorized", `no tea login for ${identity.origin}`);
  const base = `repos/${identity.repo}`;
  const pull = await teaJson(login.name, `${base}/pulls/${identity.number}`, signal);
  const detail = isRecord(pull) ? pull : {};
  const terminal = detail.merged === true || detail.state === "closed";
  const sha = isRecord(detail.head) && typeof detail.head.sha === "string" ? detail.head.sha : null;
  // A merged or closed PR needs neither checks nor reviews. An open one needs
  // both, and either failing fails the PR.
  if (!terminal && !sha) throw new LookupFailure("error", "Gitea named no head commit for an open pull request");
  const [status, reviews] = terminal
    ? [null, null]
    : await Promise.all([
        teaJson(login.name, `${base}/commits/${sha}/status`, signal),
        teaJson(login.name, `${base}/pulls/${identity.number}/reviews`, signal),
      ]);
  const facts = parseGiteaFacts(pull, status, reviews);
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

/**
 * Facts for each URL, by this host's own deadline: six commands at a time,
 * eight seconds each, 25 seconds overall. URLs the deadline leaves unread
 * are reported as timed out; the server asks again later.
 */
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
  // The caller's own abort means the whole answer is unwanted.
  signal.throwIfAborted();
  return urls.map((url) => results.get(url) ?? { url, outcome: "failed", reason: "timeout" });
}
