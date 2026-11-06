import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ServerContext } from "./server-context";
import type { SettledOverride } from "./auto-settle";
import { LIFECYCLE_CHANNEL } from "./contract";
import { canPark, hasLiveWork, isTurnInFlight, resolveShelf } from "./lifecycle";
import { threadTreeIds } from "./thread-tree";

/** One-time data repairs that need bb's thread tree, which SQL cannot see. */
export const LIFECYCLE_BACKFILLS_MIGRATION = `CREATE TABLE IF NOT EXISTS lifecycle_backfills (
  name TEXT PRIMARY KEY
)`;
const SETTLED_CHILD_ROWS_BACKFILL = "settled-child-rows";

export interface StoredLifecycleRow {
  threadId: string;
  parkedAt?: number | null;
  settledAt: number | null;
  settledOverride: SettledOverride | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
  snoozePending?: boolean;
}
interface LifecycleDbRow {
  thread_id: string;
  parked_at: number | null;
  settled_at: number | null;
  settled_override: SettledOverride | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
  snooze_pending: number;
}

export function createServerLifecycle(ctx: ServerContext) {
  const readAll = (): StoredLifecycleRow[] =>
    (
      ctx.db
        .prepare(
          `SELECT thread_id, settled_at, settled_override,
                  snoozed_until, snoozed_at, snooze_pending, parked_at
             FROM thread_lifecycle`,
        )
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      parkedAt: row.parked_at,
      settledAt: row.settled_at,
      settledOverride: row.settled_override,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
      snoozePending: row.snooze_pending === 1,
    }));

  const readOne = (threadId: string): StoredLifecycleRow | null => {
    const row = ctx.db
      .prepare(
        `SELECT thread_id, settled_at, settled_override,
                snoozed_until, snoozed_at, snooze_pending, parked_at
           FROM thread_lifecycle
          WHERE thread_id = ?`,
      )
      .get(threadId) as LifecycleDbRow | undefined;
    return row
      ? {
          threadId: row.thread_id,
          parkedAt: row.parked_at,
          settledAt: row.settled_at,
          settledOverride: row.settled_override,
          snoozedUntil: row.snoozed_until,
          snoozedAt: row.snoozed_at,
          snoozePending: row.snooze_pending === 1,
        }
      : null;
  };

  const write = (row: StoredLifecycleRow, publish = true): void => {
    ctx.db
      .prepare(
        `INSERT INTO thread_lifecycle
         (thread_id, settled_at, settled_override, snoozed_until, snoozed_at, snooze_pending, parked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         settled_override = excluded.settled_override,
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at,
         snooze_pending = excluded.snooze_pending,
         parked_at = excluded.parked_at`,
      )
      .run(
        row.threadId,
        row.settledAt,
        row.settledOverride,
        row.snoozedUntil,
        row.snoozedAt,
        row.snoozePending ? 1 : 0,
        row.parkedAt ?? null,
      );
    if (publish) {
      ctx.bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: row.threadId });
    }
  };

  const writeMany = ctx.db.transaction((rows: readonly StoredLifecycleRow[]) => {
    for (const row of rows) write(row, false);
  });

  const publishLifecycleChanges = (threadIds: readonly string[]): void => {
    if (threadIds.length === 0) return;
    ctx.bb.realtime.publish(LIFECYCLE_CHANNEL, { threadIds });
  };

  const clear = (threadId: string): void => {
    ctx.db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(threadId);
    ctx.bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
  };

  const clearSettlingState = (threadId: string): boolean => {
    const row = readOne(threadId);
    if (row === null || (row.settledAt === null && row.settledOverride === null && row.parkedAt == null)) {
      return false;
    }
    if (row.snoozedUntil === null) {
      ctx.db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(threadId);
    } else {
      write(
        {
          ...row,
          settledAt: null,
          settledOverride: null,
        },
        false,
      );
    }
    ctx.bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
    return true;
  };

  /**
   * Start a snooze set during the thread's own turn, now that the turn has
   * ended. Its final reply came before this moment, so only later attention
   * wakes it.
   */
  const startPendingSnooze = (thread: { id: string; latestAttentionAt: number }): boolean => {
    const row = readOne(thread.id);
    if (!row?.snoozePending) return false;
    write({ ...row, snoozePending: false, snoozedAt: Math.max(Date.now(), thread.latestAttentionAt) });
    return true;
  };

  /** A failed turn is news the user has not seen, so its snooze never starts. */
  const dropPendingSnooze = (threadId: string): void => {
    if (readOne(threadId)?.snoozePending) clear(threadId);
  };

  /**
   * A pending snooze outlived the server that would have seen its turn end.
   * Start each one from when it was requested: the thread may then wake on
   * its own last reply, but nothing newer can stay hidden.
   */
  const startOrphanedPendingSnoozes = (): void => {
    const ids = (
      ctx.db.prepare(`SELECT thread_id FROM thread_lifecycle WHERE snooze_pending = 1`).all() as Array<{
        thread_id: string;
      }>
    ).map((row) => row.thread_id);
    ctx.db.prepare(`UPDATE thread_lifecycle SET snooze_pending = 0 WHERE snooze_pending = 1`).run();
    publishLifecycleChanges(ids);
  };

  const sameLifecycle = (left: StoredLifecycleRow | null, right: StoredLifecycleRow | null) =>
    JSON.stringify(left) === JSON.stringify(right);

  type AncestorThread = Pick<
    Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>,
    "id" | "parentThreadId" | "archivedAt" | "deletedAt"
  >;

  const wakeAncestors = async (
    thread: { id: string; parentThreadId: string | null },
    {
      automaticOnly = false,
      threadsById,
    }: {
      automaticOnly?: boolean;
      threadsById?: ReadonlyMap<string, AncestorThread>;
    } = {},
  ) => {
    if (thread.parentThreadId === null) return [];
    // Capture all shelves before the first lookup, including ancestors whose
    // IDs we will only learn after an earlier request finishes.
    const previousRows = new Map(readAll().map((row) => [row.threadId, row]));
    const visited = new Set([thread.id]);
    const ancestors: string[] = [];
    let parentId: string | null = thread.parentThreadId;
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId);
      let parent: AncestorThread | undefined;
      try {
        // RPCs and policy passes already loaded the complete tree. Do not
        // introduce another network failure after their shelf writes succeed.
        parent = threadsById ? threadsById.get(parentId) : await ctx.bb.sdk.threads.get({ threadId: parentId });
      } catch (error) {
        ctx.bb.log.warn(
          `Could not load ancestor ${parentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
      if (!parent || parent.archivedAt !== null || parent.deletedAt !== null) break;
      ancestors.push(parent.id);
      parentId = parent.parentThreadId;
    }
    // A Settle completed while the ancestors were loading. Keep that newer
    // decision rather than reopening a tree that is already quiet again.
    if (readOne(thread.id)?.settledAt != null) return [];
    const changed = ctx.db.transaction(() => {
      const ids: string[] = [];
      for (const id of ancestors) {
        const row = readOne(id);
        if (!row || (row.settledAt === null && row.parkedAt == null && row.snoozedUntil === null)) continue;
        // A newer manual shelf choice wins over this older child event and
        // protects the ancestors above it as well.
        if (!sameLifecycle(row, previousRows.get(id) ?? null)) break;
        // Reversing an automatic rule is not new child activity. Keep the
        // user's manual shelf choice, including older parent-only settles.
        if (automaticOnly && (row.settledOverride != null || row.parkedAt != null || row.snoozedUntil != null)) break;
        ctx.db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(id);
        ids.push(id);
      }
      return ids;
    })();
    publishLifecycleChanges(changed);
    return changed;
  };

  // Pin, reparent and tree Settle must not validate the same old state.
  const pinParentChanges = new Set<string>();

  const withThreadChanges = async <T>(threadIds: string[], change: () => Promise<T>): Promise<T> => {
    if (threadIds.some((id) => pinParentChanges.has(id))) {
      throw new Error("Thread update already in progress. Try again.");
    }
    threadIds.forEach((id) => pinParentChanges.add(id));
    try {
      return await change();
    } finally {
      threadIds.forEach((id) => pinParentChanges.delete(id));
    }
  };

  const withPinParentChange = <T>(threadId: string, change: () => Promise<T>) => withThreadChanges([threadId], change);

  const readInboxOrder = (): string[] =>
    (
      ctx.db
        .prepare(
          `SELECT thread_id
             FROM inbox_order
            ORDER BY sort_index ASC, thread_id ASC`,
        )
        .all() as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);

  const replaceInboxOrder = ctx.db.transaction((inboxThreadIds: string[]) => {
    ctx.db.prepare(`DELETE FROM inbox_order`).run();
    const insert = ctx.db.prepare(`INSERT INTO inbox_order (thread_id, sort_index) VALUES (?, ?)`);
    inboxThreadIds.forEach((threadId, index) => insert.run(threadId, index));
  });

  // Both endpoints supply complete activity summaries. Project groups provide
  // visible rows in one call; only the paged thread endpoint includes helpers.
  // Use one source per read so an older project row cannot resurrect an archived
  // or deleted thread omitted from the newer thread list.
  const loadPolicyThreads = async (includeHidden = false) => {
    if (!includeHidden) {
      const projects = await ctx.bb.sdk.projects.list({ include: "threads", includePersonal: true });
      return projects.flatMap((project) =>
        "threads" in project
          ? project.threads.filter(
              (thread) => thread.archivedAt === null && thread.deletedAt === null && thread.visibility === "visible",
            )
          : [],
      );
    }
    const byId = new Map<string, Awaited<ReturnType<typeof ctx.bb.sdk.threads.list>>[number]>();
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const page = await ctx.bb.sdk.threads.list({ archived: false, includeHidden: true, limit, offset });
      for (const thread of page) {
        if (thread.archivedAt === null && thread.deletedAt === null) byId.set(thread.id, { ...thread });
        else byId.delete(thread.id);
      }
      if (page.length < limit) break;
    }
    return [...byId.values()];
  };

  /** One thread under loadPolicyThreads' rules, without listing every thread. */
  const loadPolicyThread = async (threadId: string, includeHidden = false) => {
    const [thread] = await ctx.bb.sdk.threads.list({ threadIds: [threadId], archived: false, includeHidden });
    if (!thread || thread.id !== threadId || thread.archivedAt !== null || thread.deletedAt !== null) return undefined;
    return includeHidden || thread.visibility === "visible" ? thread : undefined;
  };

  type CleanupThread = Awaited<ReturnType<typeof loadPolicyThreads>>[number];

  const threadSignals = (thread: CleanupThread) => ({
    hasPendingInteraction: thread.hasPendingInteraction,
    hasQueuedWork: thread.queuedWork !== "none",
    isWorking: hasLiveWork(
      {
        workflows: thread.activity.activeWorkflowCount,
        backgroundAgents: thread.activity.activeBackgroundAgentCount,
        backgroundCommands: thread.activity.activeBackgroundCommandCount,
        planMode: thread.activity.activePlanModeCount,
        goals: thread.activity.activeGoalCount,
      },
      isTurnInFlight(thread.status),
    ),
    isUnread: thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt,
    latestAttentionAt: thread.latestAttentionAt,
  });

  const settleTree = (threads: readonly CleanupThread[], threadId: string) => {
    const ids = new Set(threadTreeIds(threads, threadId));
    const tree = threads.filter((thread) => ids.has(thread.id));
    if (!tree.some((thread) => thread.id === threadId)) {
      throw new Error("Thread is no longer available");
    }
    return tree;
  };

  const loadSettleTree = async (threadId: string) => settleTree(await loadPolicyThreads(true), threadId);

  // Settle wrote only the root's row before it covered whole trees. Those older
  // children sit inside a settled parent in the sidebar but count as Active on
  // the server, where they protect a shared workspace from cleanup forever.
  // Give each one its nearest settled ancestor's row, once, unless it has
  // something newer to say than that settle.
  const backfillSettledChildRows = (threads: readonly CleanupThread[], now = Date.now()): string[] => {
    const done = ctx.db.prepare(`SELECT 1 FROM lifecycle_backfills WHERE name = ?`);
    if (done.get(SETTLED_CHILD_ROWS_BACKFILL)) return [];
    const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
    const settledAncestorRow = (thread: CleanupThread) => {
      const visited = new Set([thread.id]);
      let parentId = thread.parentThreadId;
      while (parentId !== null && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) return null;
        const row = readOne(parent.id);
        if (row) {
          return parent.pinnedAt === null && resolveShelf(row, threadSignals(parent), now) === "settled" ? row : null;
        }
        parentId = parent.parentThreadId;
      }
      return null;
    };
    const written = ctx.db.transaction(() => {
      const rows: StoredLifecycleRow[] = [];
      for (const thread of threads) {
        if (thread.parentThreadId === null || thread.pinnedAt !== null || readOne(thread.id) !== null) continue;
        if (!canPark(threadSignals(thread))) continue;
        const ancestor = settledAncestorRow(thread);
        if (!ancestor || thread.latestAttentionAt > ancestor.settledAt!) continue;
        rows.push({
          threadId: thread.id,
          settledAt: ancestor.settledAt,
          settledOverride: ancestor.settledOverride,
          snoozedUntil: null,
          snoozedAt: null,
        });
      }
      for (const row of rows) write(row, false);
      ctx.db.prepare(`INSERT OR IGNORE INTO lifecycle_backfills (name) VALUES (?)`).run(SETTLED_CHILD_ROWS_BACKFILL);
      return rows.map((row) => row.threadId);
    })();
    publishLifecycleChanges(written);
    return written;
  };

  return {
    readAll,
    readOne,
    write,
    writeMany,
    publishLifecycleChanges,
    clear,
    clearSettlingState,
    startPendingSnooze,
    dropPendingSnooze,
    startOrphanedPendingSnoozes,
    sameLifecycle,
    wakeAncestors,
    withThreadChanges,
    withPinParentChange,
    readInboxOrder,
    replaceInboxOrder,
    loadPolicyThreads,
    loadPolicyThread,
    threadSignals,
    settleTree,
    loadSettleTree,
    backfillSettledChildRows,
  };
}

export type CleanupThread = Awaited<ReturnType<ReturnType<typeof createServerLifecycle>["loadPolicyThreads"]>>[number];
