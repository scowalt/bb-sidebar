import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract, ScheduledSends, ThreadLimitState } from "./contract";
import { RATE_LIMITS_CHANNEL } from "./realtime-channels";
import { toast } from "./lib/toast";
import { useOnDemandLookups } from "./useOnDemandLookups";

type LimitRows = Record<string, ThreadLimitState | null>;
const RateLimitsContext = createContext<{
  rows: LimitRows;
  scheduledSends: ScheduledSends;
  pending: ReadonlySet<string>;
  schedule: (threadId: string, sendAt?: number) => Promise<boolean>;
  cancel: (threadId: string, queuedMessageId: string) => Promise<boolean>;
  /** Looks up a settled thread, which the recurring refresh skips. */
  lookUp: (threadId: string) => void;
} | null>(null);

async function inPages<T>(ids: readonly string[], fetch: (keys: string[]) => Promise<Record<string, T>>) {
  const result: Record<string, T> = {};
  for (let offset = 0; offset < ids.length; offset += 1000) {
    Object.assign(result, await fetch(ids.slice(offset, offset + 1000)));
  }
  return result;
}

function mayHaveLimit(thread: PluginSidebarThread) {
  return !thread.isArchived && (thread.status === "error" || thread.queuedWork !== "none");
}

/**
 * Provider limits for threads that are errored or have queued work. The 30s
 * poll, realtime pings and reconnects cover live threads only; a settled one
 * is looked up when the user looks at it. `settledThreadIds` is null until
 * the lifecycle rows are known, and nothing recurs before then, because every
 * thread would otherwise count as live for one full lookup.
 */
export function RateLimitsProvider({
  threads,
  settledThreadIds,
  children,
}: {
  threads: readonly PluginSidebarThread[];
  settledThreadIds: ReadonlySet<string> | null;
  children: ReactNode;
}) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const connection = useRealtimeConnectionState();
  const [rows, setRows] = useState<LimitRows>({});
  const [scheduledSends, setScheduledSends] = useState<ScheduledSends>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const mutations = useRef(new Set<string>());
  const request = useRef(0);
  const signature = JSON.stringify(
    settledThreadIds === null
      ? []
      : threads
          .filter((thread) => mayHaveLimit(thread) && !settledThreadIds.has(thread.id))
          .map((thread) => [
            thread.id,
            thread.status,
            thread.queuedWork,
            thread.status === "error" ? thread.updatedAt : 0,
          ]),
  );
  const [keys, waitingKeys] = useMemo(() => {
    const entries = JSON.parse(signature) as [string, string, string, number][];
    return [
      entries.map(([id]) => id),
      entries.flatMap(([id, , queuedWork]) => (queuedWork === "waiting" ? [id] : [])),
    ] as const;
  }, [signature]);
  const settledKey = threads
    .filter((thread) => mayHaveLimit(thread) && settledThreadIds?.has(thread.id))
    .map((thread) => thread.id)
    .join("\n");
  const settledKeys = useMemo(() => new Set(settledKey === "" ? [] : settledKey.split("\n")), [settledKey]);
  const fetchOne = useCallback(
    async (threadId: string) => (await rpc.call("getThreadLimits", { keys: [threadId] }))[threadId] ?? null,
    [rpc],
  );
  const onDemand = useOnDemandLookups(fetchOne, settledKeys);
  // A ping during a refresh waits for it and then runs one more, instead of adding a concurrent request.
  const inFlight = useRef(0);
  const pingQueued = useRef(false);
  const latestRefresh = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(async () => {
    const seq = ++request.current;
    if (keys.length === 0) {
      setRows({});
      setScheduledSends({});
      return;
    }
    inFlight.current += 1;
    try {
      const [result, sends] = await Promise.all([
        inPages(keys, (page) => rpc.call("getThreadLimits", { keys: page })),
        inPages(waitingKeys, (page) => rpc.call("getScheduledSends", { keys: page })),
      ]);
      if (seq === request.current) {
        setRows((previous) =>
          Object.fromEntries(keys.map((id) => [id, id in result ? result[id] : (previous[id] ?? null)])),
        );
        setScheduledSends((previous) =>
          Object.fromEntries(waitingKeys.map((id) => [id, id in sends ? sends[id] : (previous[id] ?? null)])),
        );
      }
    } catch {
      // Preserve the last known warning through a plugin reload or transient disconnect.
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0 && pingQueued.current) {
        pingQueued.current = false;
        void latestRefresh.current();
      }
    }
  }, [rpc, keys, waitingKeys]);
  useEffect(() => {
    latestRefresh.current = refresh;
    void refresh();
    const timer =
      keys.length > 0
        ? window.setInterval(() => {
            if (document.visibilityState !== "hidden") void refresh();
          }, 30_000)
        : undefined;
    return () => {
      request.current += 1;
      pingQueued.current = false;
      window.clearInterval(timer);
    };
  }, [refresh, keys]);
  useRealtime(RATE_LIMITS_CHANNEL, () => {
    if (inFlight.current > 0) pingQueued.current = true;
    else void refresh();
  });
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected") void refresh();
    previousConnection.current = connection;
  }, [connection, refresh]);

  const mutate = useCallback(async (threadId: string, action: () => Promise<void>) => {
    if (mutations.current.has(threadId)) return false;
    mutations.current.add(threadId);
    setPending(new Set(mutations.current));
    request.current += 1;
    try {
      await action();
      return true;
    } catch (error) {
      toast.error("Could not update scheduled Continue", {
        description: error instanceof Error ? error.message : undefined,
      });
      return false;
    } finally {
      mutations.current.delete(threadId);
      setPending(new Set(mutations.current));
    }
  }, []);
  const schedule = useCallback(
    (threadId: string, sendAt?: number) =>
      mutate(threadId, async () => {
        const limit = await rpc.call("scheduleLimitContinue", {
          threadId,
          ...(sendAt === undefined ? {} : { sendAt }),
        });
        request.current += 1;
        setRows((previous) => ({ ...previous, [threadId]: limit }));
        // The next refresh reads the queue. Until then, the new Continue would put the thread back in Active.
        if (limit.scheduled && !limit.scheduled.failed) {
          const { sendAt } = limit.scheduled;
          setScheduledSends((previous) => ({ ...previous, [threadId]: sendAt }));
        }
      }),
    [rpc, mutate],
  );
  const cancel = useCallback(
    (threadId: string, queuedMessageId: string) =>
      mutate(threadId, async () => {
        await rpc.call("cancelLimitContinue", { threadId, queuedMessageId });
        request.current += 1;
        setRows((previous) => {
          const limit = previous[threadId];
          return { ...previous, [threadId]: limit ? { ...limit, scheduled: null } : null };
        });
        await refresh();
      }),
    [rpc, mutate, refresh],
  );
  const merged = useMemo(
    () => (onDemand.values.size === 0 ? rows : { ...Object.fromEntries(onDemand.values), ...rows }),
    [onDemand.values, rows],
  );
  const { lookUp } = onDemand;
  const value = useMemo(
    () => ({ rows: merged, scheduledSends, pending, schedule, cancel, lookUp }),
    [merged, scheduledSends, pending, schedule, cancel, lookUp],
  );
  return <RateLimitsContext.Provider value={value}>{children}</RateLimitsContext.Provider>;
}

export function useThreadLimit(thread: PluginSidebarThread) {
  const context = useContext(RateLimitsContext);
  const limit = context?.rows[thread.id] ?? null;
  if (!mayHaveLimit(thread)) return null;
  return limit;
}

export function useLimitActions() {
  return useContext(RateLimitsContext);
}
