// The only writer of pull request data. It scans watched threads' event logs
// for the PRs they opened, asks each thread's host for their facts, keeps
// both in SQLite, and invalidates `pullRequestsTag(threadId)` when a thread's
// list changes. "Watched" is bb's word: some client has the thread's
// `getPullRequests` key on screen (`bb.rpc.experimental_whileWatched`).
import { z } from "zod";
import type { ServerContext } from "./server-context";
import { pullRequestFactsSchema } from "./contract";
import { portScanContract } from "./port-scan-contract";
import { confirmGiteaConflict, createdPullRequestUrls, parsePullRequestUrl } from "./pull-request-forges";
import { isDone, pullRequestStatus, type PullRequestFacts, type ThreadPullRequests } from "./pull-request-status";
import { pullRequestsTag } from "./rpc-tags";
import { GITHUB_PR_STATUS_PLUGIN_ID, MAX_PULL_REQUEST_KEYS } from "./github-pr-status";
import { runThreadTasks } from "./thread-tasks";

export const PULL_REQUESTS_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS pull_request_scans (
     thread_id  TEXT PRIMARY KEY,
     after_seq  INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS thread_pull_requests (
     thread_id  TEXT NOT NULL,
     url        TEXT NOT NULL,
     found_seq  INTEGER NOT NULL,
     PRIMARY KEY (thread_id, url)
   )`,
  `CREATE TABLE IF NOT EXISTS pull_requests (
     url         TEXT PRIMARY KEY,
     facts_json  TEXT,
     checked_at  INTEGER NOT NULL,
     failures    INTEGER NOT NULL DEFAULT 0
   )`,
  // The last lookup was Gitea's first `mergeable: false` in a row, withheld
  // until a second one confirms it (`confirmGiteaConflict`).
  `ALTER TABLE pull_requests ADD COLUMN unconfirmed_conflict INTEGER NOT NULL DEFAULT 0`,
];

// bb rejects event pages larger than 100.
const EVENT_PAGE_SIZE = 100;
/** A scan run reads at most this many pages; the rest waits for the next tick. */
const MAX_PAGES_PER_RUN = 20;
/** Never-scanned threads that may start per tick, so a cold start stays bounded. */
const COLD_SCANS_PER_TICK = 5;
const SCAN_CONCURRENCY = 3;
const TICK_MS = 20_000;
/** A whole sidebar mounting at once lands in one tick. */
const DEBOUNCE_MS = 250;
const OPEN_RECHECK_MS = 2 * 60_000;
/** Below the tick, so running checks and Gitea's `mergeable: false` are asked about on every tick. */
const PENDING_RECHECK_MS = 15_000;
const FAILURE_BACKOFF_MS = [60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000] as const;
const THREAD_FACTS_TTL_MS = 60_000;
const LOOKUP_CHUNK = 20;
const HOST_CALL_TIMEOUT_MS = 30_000;
const BRANCH_LOOKUP_TIMEOUT_MS = 60_000;

interface PullRequestThreadFacts {
  /** Its sidebar row is Settled (a child follows its tree's top row). */
  settled: boolean;
  environmentId: string | null;
  hostId: string | null;
  isWorktree: boolean;
}

interface StoredUrlRow {
  url: string;
  facts_json: string | null;
  checked_at: number | null;
  failures: number | null;
  unconfirmed_conflict: number | null;
}

const branchRowSchema = z.object({ outcome: z.literal("available"), pullRequest: z.object({ url: z.string() }) });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createServerPullRequests(
  ctx: ServerContext,
  deps: {
    /** Where these threads sit and run. Ids bb no longer lists are left out. */
    describeThreads(threadIds: readonly string[]): Promise<ReadonlyMap<string, PullRequestThreadFacts>>;
  },
) {
  const { bb, db } = ctx;
  const host = bb.hosts.experimental_client({ contract: portScanContract });
  const controller = new AbortController();

  const selectScan = db.prepare(`SELECT after_seq FROM pull_request_scans WHERE thread_id = ?`);
  const upsertScan = db.prepare(
    `INSERT INTO pull_request_scans (thread_id, after_seq) VALUES (?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET after_seq = excluded.after_seq`,
  );
  const insertThreadUrl = db.prepare(
    `INSERT OR IGNORE INTO thread_pull_requests (thread_id, url, found_seq) VALUES (?, ?, ?)`,
  );
  const selectThreadUrls = db.prepare(
    `SELECT t.url, p.facts_json, p.checked_at, p.failures, p.unconfirmed_conflict
       FROM thread_pull_requests t LEFT JOIN pull_requests p ON p.url = t.url
      WHERE t.thread_id = ?
      ORDER BY t.found_seq, t.rowid`,
  );
  const selectUrl = db.prepare(`SELECT facts_json, unconfirmed_conflict FROM pull_requests WHERE url = ?`);
  // Writes land only for URLs some thread still lists, so a thread deleted
  // mid-lookup leaves nothing behind.
  const writeFacts = db.prepare(
    `INSERT INTO pull_requests (url, facts_json, checked_at, failures, unconfirmed_conflict)
     SELECT ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM thread_pull_requests WHERE url = ?)
     ON CONFLICT(url) DO UPDATE SET facts_json = excluded.facts_json, checked_at = excluded.checked_at,
       failures = 0, unconfirmed_conflict = excluded.unconfirmed_conflict`,
  );
  const writeFailure = db.prepare(
    `INSERT INTO pull_requests (url, facts_json, checked_at, failures)
     SELECT ?, NULL, ?, 1 WHERE EXISTS (SELECT 1 FROM thread_pull_requests WHERE url = ?)
     ON CONFLICT(url) DO UPDATE SET checked_at = excluded.checked_at, failures = pull_requests.failures + 1`,
  );
  const deleteThreadUrls = db.prepare(`DELETE FROM thread_pull_requests WHERE thread_id = ?`);
  const deleteScan = db.prepare(`DELETE FROM pull_request_scans WHERE thread_id = ?`);
  const deleteOrphans = db.prepare(`DELETE FROM pull_requests WHERE url NOT IN (SELECT url FROM thread_pull_requests)`);

  const scanRow = (threadId: string) => selectScan.get(threadId) as { after_seq: number | null } | undefined;
  const urlRows = (threadId: string) => selectThreadUrls.all(threadId) as StoredUrlRow[];
  const parseFacts = (json: string | null): PullRequestFacts | null => {
    if (json === null) return null;
    try {
      const parsed = pullRequestFactsSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  /** What a found answer stores: Gitea's first `mergeable: false` in a row is withheld. */
  const settleFacts = (url: string, next: PullRequestFacts) => {
    if (parsePullRequestUrl(url)?.forge !== "gitea") return { facts: next, unconfirmed: false };
    const previous = selectUrl.get(url) as Pick<StoredUrlRow, "facts_json" | "unconfirmed_conflict"> | undefined;
    return confirmGiteaConflict(
      { facts: parseFacts(previous?.facts_json ?? null), unconfirmed: previous?.unconfirmed_conflict === 1 },
      next,
    );
  };

  const readOne = (threadId: string): ThreadPullRequests => ({
    entries: urlRows(threadId).flatMap((row) => {
      const identity = parsePullRequestUrl(row.url);
      return identity
        ? [{ url: row.url, repo: identity.repo, number: identity.number, facts: parseFacts(row.facts_json) }]
        : [];
    }),
    scanned: scanRow(threadId) !== undefined,
  });

  // How many producers hold each thread; a thread is watched while above zero.
  const watchers = new Map<string, number>();
  // Watched since the last tick, or just finished a turn: scan now and look
  // up even if Settled.
  const kicked = new Set<string>();
  const working = new Set<string>();
  const inFlight = new Set<string>();
  const hostFailureLogged = new Set<string>();
  let factsCache: { at: number; ids: ReadonlySet<string>; map: ReadonlyMap<string, PullRequestThreadFacts> } | null =
    null;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerun = false;
  const schedule = (delayMs: number) => {
    if (controller.signal.aborted) return;
    if (running) {
      rerun = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
  };
  const run = async () => {
    running = true;
    try {
      await tick();
    } catch (error) {
      if (!controller.signal.aborted) bb.log.error(`Pull request refresh failed: ${errorMessage(error)}`);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        schedule(DEBOUNCE_MS);
      } else if (watchers.size) {
        schedule(TICK_MS);
      }
    }
  };
  bb.onDispose(() => {
    controller.abort();
    if (timer) clearTimeout(timer);
    timer = null;
  });

  const threadFacts = async (ids: readonly string[]) => {
    const now = Date.now();
    if (factsCache && now - factsCache.at < THREAD_FACTS_TTL_MS && ids.every((id) => factsCache!.ids.has(id))) {
      return factsCache.map;
    }
    const map = await deps.describeThreads(ids);
    factsCache = { at: now, ids: new Set(ids), map };
    return map;
  };

  const scanThread = async (threadId: string) => {
    let afterSeq = scanRow(threadId)?.after_seq ?? null;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const events = await bb.sdk.threads.events.list({
        threadId,
        types: ["item/completed"],
        order: "asc",
        limit: String(EVENT_PAGE_SIZE),
        ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }),
        signal: controller.signal,
      });
      const urls = createdPullRequestUrls(events);
      const lastSeq = events.length ? events[events.length - 1]!.seq : afterSeq;
      db.transaction(() => {
        for (const url of urls) insertThreadUrl.run(threadId, url, lastSeq ?? 0);
        upsertScan.run(threadId, lastSeq);
      })();
      afterSeq = lastSeq;
      if (events.length < EVENT_PAGE_SIZE) return;
    }
    // More pages remain: pick the scan up again next tick.
    kicked.add(threadId);
  };

  // The PR on a worktree's checked-out branch, from GitHub PR Status, joins
  // the list like a scanned one: a PR opened outside `gh pr create`. Only
  // its URL is used; its facts come from `gh` like every other PR's.
  const discoverBranchPullRequests = async (
    threadIds: readonly string[],
    facts: ReadonlyMap<string, PullRequestThreadFacts>,
  ) => {
    const owners = threadIds.filter((id) => {
      const thread = facts.get(id);
      return thread?.isWorktree && thread.environmentId && watchers.has(id);
    });
    if (!owners.length) return;
    const environmentIds = [...new Set(owners.map((id) => facts.get(id)!.environmentId!))];
    const rows: Record<string, unknown> = {};
    for (let start = 0; start < environmentIds.length; start += MAX_PULL_REQUEST_KEYS) {
      try {
        Object.assign(
          rows,
          await bb.sdk.plugins.callRpc({
            pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
            method: "pullRequests",
            input: { keys: environmentIds.slice(start, start + MAX_PULL_REQUEST_KEYS) },
            outputSchema: z.record(z.string(), z.unknown()),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(BRANCH_LOOKUP_TIMEOUT_MS)]),
          }),
        );
      } catch (error) {
        // GitHub PR Status disabled or failing: the scanned list still shows.
        if (controller.signal.aborted) throw error;
        bb.log.debug(`Branch pull request discovery failed: ${errorMessage(error)}`);
        return;
      }
    }
    db.transaction(() => {
      for (const threadId of owners) {
        const row = branchRowSchema.safeParse(rows[facts.get(threadId)!.environmentId!]);
        if (!row.success || !parsePullRequestUrl(row.data.pullRequest.url)) continue;
        insertThreadUrl.run(threadId, row.data.pullRequest.url, scanRow(threadId)?.after_seq ?? 0);
      }
    })();
  };

  const isDue = (row: StoredUrlRow, now: number) => {
    if (row.checked_at === null) return true;
    const failures = row.failures ?? 0;
    if (failures > 0)
      return now - row.checked_at >= FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1]!;
    const facts = parseFacts(row.facts_json);
    if (!facts) return true;
    const status = pullRequestStatus({ url: row.url, repo: "", number: 0, facts });
    if (isDone(status)) return false;
    // Gitea's `mergeable: false` also means "still checking", so it is asked about again soon.
    const soon =
      status === "checks_pending" ||
      row.unconfirmed_conflict === 1 ||
      (status === "conflicts" && parsePullRequestUrl(row.url)?.forge === "gitea");
    return now - row.checked_at >= (soon ? PENDING_RECHECK_MS : OPEN_RECHECK_MS);
  };

  const lookUpOnHost = async (hostId: string, urls: readonly string[]) => {
    for (let start = 0; start < urls.length; start += LOOKUP_CHUNK) {
      const chunk = urls.slice(start, start + LOOKUP_CHUNK);
      for (const url of chunk) inFlight.add(url);
      try {
        const { pullRequests } = await host.call(
          "lookUpPullRequests",
          { urls: chunk },
          { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS, signal: controller.signal },
        );
        const now = Date.now();
        const answered = new Set<string>();
        db.transaction(() => {
          for (const result of pullRequests) {
            answered.add(result.url);
            if (result.outcome === "found") {
              const { facts, unconfirmed } = settleFacts(result.url, result.facts);
              writeFacts.run(result.url, JSON.stringify(facts), now, unconfirmed ? 1 : 0, result.url);
            } else writeFailure.run(result.url, now, result.url);
          }
          for (const url of chunk) if (!answered.has(url)) writeFailure.run(url, now, url);
        })();
        hostFailureLogged.delete(hostId);
      } catch (error) {
        if (controller.signal.aborted) return;
        const now = Date.now();
        db.transaction(() => {
          for (const url of chunk) writeFailure.run(url, now, url);
        })();
        if (!hostFailureLogged.has(hostId)) {
          bb.log.warn(`Pull request lookup on host ${hostId} failed: ${errorMessage(error)}`);
          hostFailureLogged.add(hostId);
        }
      } finally {
        for (const url of chunk) inFlight.delete(url);
      }
    }
  };

  const tick = async () => {
    // Only threads someone still watches get work; a kick from a client that
    // already left (a card opened and closed) is dropped with it.
    const ids = [...watchers.keys()];
    const kickedNow = new Set(ids.filter((id) => kicked.has(id)));
    kicked.clear();
    if (!ids.length) return;
    const before = new Map(ids.map((id) => [id, JSON.stringify(readOne(id))]));
    const facts = await threadFacts(ids);

    const candidates = ids.filter((id) => kickedNow.has(id) || (working.has(id) && watchers.has(id)));
    const cold = candidates.filter((id) => scanRow(id) === undefined);
    const coldNow = [...cold.filter((id) => kickedNow.has(id)), ...cold.filter((id) => !kickedNow.has(id))].slice(
      0,
      COLD_SCANS_PER_TICK,
    );
    for (const id of cold) if (!coldNow.includes(id)) kicked.add(id);
    const scanIds = [...coldNow, ...candidates.filter((id) => !cold.includes(id))];
    const scans = await runThreadTasks(scanIds, scanThread, SCAN_CONCURRENCY);
    for (const failure of scans.failures)
      bb.log.debug(`Scanning ${failure.threadId} for pull requests: ${failure.error}`);
    await discoverBranchPullRequests(scanIds, facts);

    const now = Date.now();
    const dueByHost = new Map<string, Set<string>>();
    for (const id of ids) {
      const thread = facts.get(id);
      if (!thread?.hostId || (thread.settled && !kickedNow.has(id))) continue;
      for (const row of urlRows(id)) {
        if (inFlight.has(row.url) || !isDue(row, now)) continue;
        let urls = dueByHost.get(thread.hostId);
        if (!urls) dueByHost.set(thread.hostId, (urls = new Set()));
        urls.add(row.url);
      }
    }
    await Promise.all([...dueByHost].map(([hostId, urls]) => lookUpOnHost(hostId, [...urls])));

    const changed = ids.filter((id) => before.get(id) !== JSON.stringify(readOne(id)));
    if (changed.length) bb.rpc.experimental_invalidate(changed.map(pullRequestsTag));
  };

  return {
    /** The keyed read: SQLite only, never waits on a scan or a host. */
    read(threadIds: readonly string[]): Record<string, ThreadPullRequests> {
      return Object.fromEntries(threadIds.map((threadId) => [threadId, readOne(threadId)]));
    },
    /** The `whileWatched` producer: the thread is watched until `signal` aborts. */
    watch(threadId: string, signal: AbortSignal) {
      if (signal.aborted) return;
      watchers.set(threadId, (watchers.get(threadId) ?? 0) + 1);
      kicked.add(threadId);
      signal.addEventListener(
        "abort",
        () => {
          const remaining = (watchers.get(threadId) ?? 1) - 1;
          if (remaining <= 0) watchers.delete(threadId);
          else watchers.set(threadId, remaining);
        },
        { once: true },
      );
      schedule(DEBOUNCE_MS);
    },
    /** `thread.active`: the log is growing; rescan on every tick while watched. */
    turnStarted(threadId: string) {
      working.add(threadId);
    },
    /** `thread.idle` or `thread.failed`: one last scan catches a create in the final command. */
    turnEnded(threadId: string) {
      working.delete(threadId);
      if (!watchers.has(threadId)) return;
      kicked.add(threadId);
      schedule(DEBOUNCE_MS);
    },
    /** `thread.deleted`: its rows, and any PR no other thread lists. */
    forget(threadId: string) {
      working.delete(threadId);
      kicked.delete(threadId);
      db.transaction(() => {
        deleteThreadUrls.run(threadId);
        deleteScan.run(threadId);
        deleteOrphans.run();
      })();
    },
  };
}
