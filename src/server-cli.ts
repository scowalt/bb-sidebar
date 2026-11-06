import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import type { PluginCliContext } from "@get-bb/plugin-sdk";
import type { ServerHandlers } from "./server-context";
import type { createServerLifecycle } from "./server-lifecycle";
import {
  configuredSnoozePresetError,
  formatSnoozeWakeTime,
  MAX_SNOOZE_MS,
  parseConfiguredSnoozePresets,
  resolveConfiguredSnoozePreset,
  resolveShelf,
} from "./lifecycle";

type CliHandlers = Pick<
  ServerHandlers,
  "pin" | "park" | "resume" | "settle" | "unsettle" | "snooze" | "unsnooze" | "setThreadParent"
>;

const SHELVES = ["active", "snoozed", "settled", "parked"] as const;

const threadOption = {
  thread: {
    type: "string",
    placeholder: "thread-id",
    aliases: ["thread-id", "id"],
    description: "Thread to act on; defaults to the calling thread",
  },
} as const;

function targetThread(thread: string | undefined, ctx: PluginCliContext): string {
  const threadId = thread?.trim() || ctx.threadId;
  if (!threadId) {
    throw new PluginCliError("No thread given and no calling thread", {
      code: "missing_thread",
      hint: "Add --thread <thread-id>.",
    });
  }
  return threadId;
}

// Handler errors are user-facing sentences already; report them as CLI errors
// instead of letting the host print a crash.
async function act(run: () => Promise<string>) {
  try {
    return { exitCode: 0, stdout: `${await run()}\n` };
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "action_failed" });
  }
}

/** Accept the sidebar's snooze shortcut grammar (2h, tomorrow@09:00) or a local date-time. */
function parseWake(value: string, now = new Date()): number {
  const text = value.trim();
  let wake: number | null = null;
  if (!text.includes(",") && configuredSnoozePresetError(text) === null) {
    wake = resolveConfiguredSnoozePreset(parseConfiguredSnoozePresets(text)[0]!, now);
  } else if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const parsed = Date.parse(text);
    wake = Number.isNaN(parsed) ? null : parsed;
  }
  if (wake === null || wake <= now.getTime() || wake > now.getTime() + MAX_SNOOZE_MS) {
    throw new PluginCliError(`Cannot snooze until '${value}'`, {
      code: "invalid_value",
      hint: "Use 30m, 2h, 3d, 1w, evening, tomorrow@09:00, next-week, or 2026-11-02T09:00, within a year.",
    });
  }
  return wake;
}

export function createServerCli(lifecycle: ReturnType<typeof createServerLifecycle>, handlers: CliHandlers) {
  const { loadPolicyThreads, readOne, threadSignals } = lifecycle;

  return defineCli({
    name: "sidebar",
    summary: "Snooze, settle, park, pin, and re-parent threads in the BB Sidebar",
    commands: {
      list: cliCommand({
        summary: "List threads with their sidebar shelf",
        options: {
          state: { type: "enum", values: SHELVES, description: "Only threads on this shelf" },
          all: { type: "boolean", description: "Every project, not just the calling thread's" },
          limit: {
            type: "integer",
            min: 1,
            max: 500,
            default: 30,
            description: "Threads per page, most recent first; 1-500",
          },
          offset: {
            type: "integer",
            min: 0,
            max: 1_000_000,
            default: 0,
            description: "Skip this many matching threads; the output names the next page's offset",
          },
          json: { type: "boolean", description: "Emit JSON: { threads, total, offset, nextOffset }" },
        },
        async run({ options }, ctx) {
          const now = Date.now();
          const matching = (await loadPolicyThreads())
            .filter((thread) => options.all || !ctx.projectId || thread.projectId === ctx.projectId)
            .map((thread) => {
              const row = readOne(thread.id);
              const shelf = resolveShelf(row ?? undefined, threadSignals(thread), now);
              return { thread, row, shelf };
            })
            .filter(({ shelf }) => !options.state || shelf === options.state)
            // Ties break by id so pages stay stable between calls.
            .sort(
              (left, right) =>
                right.thread.latestAttentionAt - left.thread.latestAttentionAt ||
                left.thread.id.localeCompare(right.thread.id),
            );
          const total = matching.length;
          const { offset } = options;
          const threads = matching.slice(offset, offset + options.limit);
          const nextOffset = offset + threads.length < total ? offset + threads.length : null;
          if (options.json) {
            const rows = threads.map(({ thread, row, shelf }) => ({
              threadId: thread.id,
              title: thread.title,
              shelf,
              pinned: thread.pinnedAt !== null,
              parentThreadId: thread.parentThreadId,
              snoozedUntil: shelf === "snoozed" ? (row?.snoozedUntil ?? null) : null,
            }));
            return { exitCode: 0, stdout: `${JSON.stringify({ threads: rows, total, offset, nextOffset })}\n` };
          }
          const lines = threads.map(({ thread, row, shelf }) => {
            const until =
              shelf === "snoozed" && row?.snoozedUntil ? ` until ${formatSnoozeWakeTime(row.snoozedUntil)}` : "";
            const pinned = thread.pinnedAt !== null ? " pinned" : "";
            const parent = thread.parentThreadId ? ` (child of ${thread.parentThreadId})` : "";
            return `${thread.id}\t${shelf}${pinned}${until}\t${thread.title ?? "Untitled"}${parent}`;
          });
          if (total === 0) return { exitCode: 0, stdout: "No threads\n" };
          if (threads.length === 0) return { exitCode: 0, stdout: `No threads at offset ${offset}; ${total} match\n` };
          const page = `Showing ${offset + 1}-${offset + threads.length} of ${total}`;
          const footer = nextOffset === null ? (offset > 0 ? page : "") : `${page}; next page: --offset ${nextOffset}`;
          return { exitCode: 0, stdout: `${[...lines, ...(footer ? [footer] : [])].join("\n")}\n` };
        },
      }),
      snooze: cliCommand({
        summary: "Hide a thread until a time",
        positionals: [
          { name: "until", required: true, description: "2h, tomorrow, next-week@09:00, or a local ISO time" },
        ],
        options: threadOption,
        run: ({ positionals, options }, ctx) => {
          const threadId = targetThread(options.thread, ctx);
          const snoozedUntil = parseWake(positionals.until);
          return act(async () => {
            await handlers.snooze({ threadId, snoozedUntil });
            const starts = lifecycle.readOne(threadId)?.snoozePending ? ", starting when its turn ends" : "";
            return `snoozed ${threadId} until ${formatSnoozeWakeTime(snoozedUntil)}${starts}`;
          });
        },
      }),
      unsnooze: cliCommand({
        summary: "Return a snoozed thread to Active now",
        options: threadOption,
        run: ({ options }, ctx) => {
          const threadId = targetThread(options.thread, ctx);
          return act(async () => {
            await handlers.unsnooze({ threadId });
            return `unsnoozed ${threadId}`;
          });
        },
      }),
      settle: cliCommand({
        summary: "Settle an idle thread and its children",
        options: threadOption,
        run: ({ options }, ctx) => {
          const threadId = targetThread(options.thread, ctx);
          return act(async () => {
            await handlers.settle({ threadId });
            return `settled ${threadId}`;
          });
        },
      }),
      park: cliCommand({
        summary: "Park a thread until it gets new activity",
        options: threadOption,
        run: ({ options }, ctx) => {
          const threadId = targetThread(options.thread, ctx);
          return act(async () => {
            await handlers.park({ threadId });
            return `parked ${threadId}`;
          });
        },
      }),
      resume: cliCommand({
        summary: "Return a snoozed, settled, or parked thread to Active",
        options: threadOption,
        run: ({ options }, ctx) => {
          const threadId = targetThread(options.thread, ctx);
          return act(async () => {
            const row = readOne(threadId);
            // Each shelf has its own way back, matching the sidebar's menus.
            if (row?.snoozedUntil != null) await handlers.unsnooze({ threadId });
            else if (row?.settledAt != null) await handlers.unsettle({ threadId });
            else if (row?.parkedAt != null) await handlers.resume({ threadId });
            else return `${threadId} is already active`;
            return `resumed ${threadId}`;
          });
        },
      }),
      pin: cliCommand({
        summary: "Pin a top-level thread",
        options: threadOption,
        run: ({ options }, ctx) => {
          const threadId = targetThread(options.thread, ctx);
          return act(async () => {
            await handlers.pin({ threadId });
            return `pinned ${threadId}`;
          });
        },
      }),
      parent: cliCommand({
        summary: "Nest a thread under a parent, or --clear to make it top-level",
        positionals: [{ name: "parent", description: "Parent thread id" }],
        options: { ...threadOption, clear: { type: "boolean", description: "Remove the parent" } },
        run: ({ positionals, options }, ctx) => {
          const threadId = targetThread(options.thread, ctx);
          if (Boolean(positionals.parent) === options.clear) {
            throw new PluginCliError("Give a parent thread id or --clear, not both", {
              code: "invalid_value",
              hint: "bb sidebar parent <parent-thread-id> or bb sidebar parent --clear",
            });
          }
          const parentThreadId = positionals.parent?.trim() || null;
          return act(async () => {
            const result = await handlers.setThreadParent({ threadId, parentThreadId });
            const moved = parentThreadId ? `moved ${threadId} under ${parentThreadId}` : `made ${threadId} top-level`;
            return "unpinFailed" in result && result.unpinFailed ? `${moved}; it is still pinned` : moved;
          });
        },
      }),
    },
  });
}
