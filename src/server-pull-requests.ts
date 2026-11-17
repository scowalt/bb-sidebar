import { z } from "zod";
import type { ServerContext } from "./server-context";
import { pullRequestFactsSchema } from "./pull-request-schemas";
import { PULL_REQUEST_HOST_CALL_TIMEOUT_MS, portScanContract } from "./port-scan-contract";
import { confirmGiteaConflict, createdPullRequestUrls, parsePullRequestUrl } from "./pull-request-forges";
import {
  isDone,
  pullRequestStatus,
  type PullRequestFacts,
  type PullRequestStatus,
  type ThreadPullRequests,
} from "./pull-request-status";
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
  `ALTER TABLE pull_requests ADD COLUMN unconfirmed_conflict INTEGER NOT NULL DEFAULT 0`,
];

// bb rejects event pages larger than 100.
const EVENT_PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 20;
const COLD_SCANS_PER_TICK = 5;
const SCAN_CONCURRENCY = 3;
const TICK_MS = 20_000;
const DEBOUNCE_MS = 250;
const OPEN_RECHECK_MS = 2 * 60_000;
const PENDING_RECHECK_MS = 15_000;
const FAILURE_BACKOFF_MS = [60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000] as const;
const THREAD_FACTS_TTL_MS = 60_000;
const LOOKUP_CHUNK = 20;
const LOOKUPS_PER_HOST_PER_TICK = 40;
const BRANCH_LOOKUP_TIMEOUT_MS = 60_000;

interface PullRequestThreadFacts {
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

const giteaMayStillBeChecking = (row: StoredUrlRow, status: PullRequestStatus) =>
  row.unconfirmed_conflict === 1 || (status === "conflicts" && parsePullRequestUrl(row.url)?.forge === "gitea");

const branchRowSchema = z.object({ outcome: z.literal("available"), pullRequest: z.object({ url: z.string() }) });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createServerPullRequests(
  ctx: ServerContext,
  deps: {
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
  const writeFactsIfListed = db.prepare(
    `INSERT INTO pull_requests (url, facts_json, checked_at, failures, unconfirmed_conflict)
     SELECT ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM thread_pull_requests WHERE url = ?)
     ON CONFLICT(url) DO UPDATE SET facts_json = excluded.facts_json, checked_at = excluded.checked_at,
       failures = 0, unconfirmed_conflict = excluded.unconfirmed_conflict`,
  );
  const writeFailureIfListed = db.prepare(
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
    scanFailed: scanFailures.has(threadId),
  });

  const watchers = new Map<string, number>();
  const urgent = new Set<string>();
  const scanFailures = new Map<string, { count: number; at: number }>();
  const working = new Set<string>();
  const inFlight = new Set<string>();
  const hostFailureLogged = new Set<string>();
  const threadFactsCache = new Map<string, { at: number; facts: PullRequestThreadFacts | null }>();

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
    const stale = ids.filter((id) => now - (threadFactsCache.get(id)?.at ?? 0) >= THREAD_FACTS_TTL_MS);
    if (stale.length) {
      const described = await deps.describeThreads(stale);
      for (const id of stale) threadFactsCache.set(id, { at: now, facts: described.get(id) ?? null });
    }
    for (const id of threadFactsCache.keys()) if (!watchers.has(id)) threadFactsCache.delete(id);
    const map = new Map<string, PullRequestThreadFacts>();
    for (const id of ids) {
      const facts = threadFactsCache.get(id)?.facts;
      if (facts) map.set(id, facts);
    }
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
    urgent.add(threadId);
  };

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

  const lookupDue = (row: StoredUrlRow, now: number): "soon" | "later" | null => {
    if (row.checked_at === null) return "soon";
    const failures = row.failures ?? 0;
    if (failures > 0) {
      const backoff = FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1]!;
      return now - row.checked_at >= backoff ? "later" : null;
    }
    const facts = parseFacts(row.facts_json);
    if (!facts) return "soon";
    const status = pullRequestStatus({ url: row.url, repo: "", number: 0, facts });
    if (isDone(status)) return null;
    if (status === "checks_pending" || giteaMayStillBeChecking(row, status))
      return now - row.checked_at >= PENDING_RECHECK_MS ? "soon" : null;
    return now - row.checked_at >= OPEN_RECHECK_MS ? "later" : null;
  };

  const lookUpOnHost = async (hostId: string, urls: readonly string[], stillWanted: (url: string) => boolean) => {
    for (let start = 0; start < urls.length; start += LOOKUP_CHUNK) {
      const chunk = urls.slice(start, start + LOOKUP_CHUNK).filter(stillWanted);
      if (!chunk.length) continue;
      for (const url of chunk) inFlight.add(url);
      try {
        const { pullRequests } = await host.call(
          "lookUpPullRequests",
          { urls: chunk },
          { hostId, timeoutMs: PULL_REQUEST_HOST_CALL_TIMEOUT_MS, signal: controller.signal },
        );
        const now = Date.now();
        const answered = new Set<string>();
        db.transaction(() => {
          for (const result of pullRequests) {
            answered.add(result.url);
            if (result.outcome === "found") {
              const { facts, unconfirmed } = settleFacts(result.url, result.facts);
              writeFactsIfListed.run(result.url, JSON.stringify(facts), now, unconfirmed ? 1 : 0, result.url);
            } else writeFailureIfListed.run(result.url, now, result.url);
          }
          for (const url of chunk) if (!answered.has(url)) writeFailureIfListed.run(url, now, url);
        })();
        hostFailureLogged.delete(hostId);
      } catch (error) {
        if (controller.signal.aborted) return;
        const now = Date.now();
        db.transaction(() => {
          for (const url of chunk) writeFailureIfListed.run(url, now, url);
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
    const ids = [...watchers.keys()];
    const urgentNow = new Set(ids.filter((id) => urgent.has(id)));
    urgent.clear();
    if (!ids.length) return;
    const before = new Map(ids.map((id) => [id, JSON.stringify(readOne(id))]));
    const facts = await threadFacts(ids);

    const retryDue = (id: string) => {
      const failure = scanFailures.get(id);
      return (
        failure !== undefined &&
        Date.now() - failure.at >= FAILURE_BACKOFF_MS[Math.min(failure.count, FAILURE_BACKOFF_MS.length) - 1]!
      );
    };
    const candidates = ids.filter((id) => urgentNow.has(id) || working.has(id) || retryDue(id));
    const cold = candidates.filter((id) => scanRow(id) === undefined);
    const coldNow = [...cold.filter((id) => urgentNow.has(id)), ...cold.filter((id) => !urgentNow.has(id))].slice(
      0,
      COLD_SCANS_PER_TICK,
    );
    for (const id of cold) if (!coldNow.includes(id)) urgent.add(id);
    const scanIds = [...coldNow, ...candidates.filter((id) => !cold.includes(id))];
    const scans = await runThreadTasks(scanIds, scanThread, SCAN_CONCURRENCY);
    const failedScans = new Set(scans.failures.map((failure) => failure.threadId));
    for (const id of scanIds) if (!failedScans.has(id)) scanFailures.delete(id);
    for (const failure of scans.failures) {
      scanFailures.set(failure.threadId, {
        count: (scanFailures.get(failure.threadId)?.count ?? 0) + 1,
        at: Date.now(),
      });
      bb.log.debug(`Scanning ${failure.threadId} for pull requests: ${failure.error}`);
    }
    await discoverBranchPullRequests(scanIds, facts);

    const now = Date.now();
    const dueByHost = new Map<string, Map<string, number>>();
    const threadsOf = new Map<string, Set<string>>();
    for (const id of ids) {
      const thread = facts.get(id);
      if (!thread?.hostId || (thread.settled && !urgentNow.has(id))) continue;
      for (const row of urlRows(id)) {
        let owners = threadsOf.get(row.url);
        if (!owners) threadsOf.set(row.url, (owners = new Set()));
        owners.add(id);
        const due = inFlight.has(row.url) ? null : lookupDue(row, now);
        if (!due) continue;
        const rank = urgentNow.has(id) ? 0 : due === "soon" ? 1 : 2;
        let ranked = dueByHost.get(thread.hostId);
        if (!ranked) dueByHost.set(thread.hostId, (ranked = new Map()));
        ranked.set(row.url, Math.min(rank, ranked.get(row.url) ?? rank));
      }
    }
    const stillWanted = (url: string) => [...(threadsOf.get(url) ?? [])].some((id) => watchers.has(id));
    await Promise.all(
      [...dueByHost].map(([hostId, ranked]) => {
        const urls = [...ranked]
          .sort(([, a], [, b]) => a - b)
          .slice(0, LOOKUPS_PER_HOST_PER_TICK)
          .map(([url]) => url);
        return lookUpOnHost(hostId, urls, stillWanted);
      }),
    );

    const changed = ids.filter((id) => before.get(id) !== JSON.stringify(readOne(id)));
    if (changed.length) bb.rpc.experimental_invalidate(changed.map(pullRequestsTag));
  };

  return {
    read(threadIds: readonly string[]): Record<string, ThreadPullRequests> {
      return Object.fromEntries(threadIds.map((threadId) => [threadId, readOne(threadId)]));
    },
    watch(threadId: string, signal: AbortSignal) {
      if (signal.aborted) return;
      watchers.set(threadId, (watchers.get(threadId) ?? 0) + 1);
      urgent.add(threadId);
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
    turnStarted(threadId: string) {
      working.add(threadId);
    },
    turnEnded(threadId: string) {
      working.delete(threadId);
      if (!watchers.has(threadId)) return;
      urgent.add(threadId);
      schedule(DEBOUNCE_MS);
    },
    forget(threadId: string) {
      working.delete(threadId);
      urgent.delete(threadId);
      scanFailures.delete(threadId);
      db.transaction(() => {
        deleteThreadUrls.run(threadId);
        deleteScan.run(threadId);
        deleteOrphans.run();
      })();
    },
  };
}
