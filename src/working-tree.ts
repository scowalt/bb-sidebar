import type { PluginSidebarThread, PluginSidebarThreadRowStatus } from "@get-bb/plugin-sdk/app";
import { resolveThreadStatus } from "./bb-sdk";
import {
  childSubtree,
  threadAsksForInput,
  threadFailed,
  threadNeedsAttention,
  type ThreadWorking,
} from "./child-status";

/**
 * Whether a thread is working, for display: bb's own rule, from bb's status
 * resolver, over the thread and its own row status. A running runtime, any
 * workflow, background agent, background command or plan mode, and another
 * plugin's status with the "running" tone all count. A thread whose machine
 * is disconnected, or that has not started, does not.
 *
 * Display only. Parking, settling, shelf placement and the working clock keep
 * `isThreadWorking` from shared lifecycle.ts, which the server mirrors from
 * rows that never carry another plugin's status.
 */
export function isThreadWorkingForDisplay(
  thread: PluginSidebarThread,
  rowStatus: PluginSidebarThreadRowStatus | null,
): boolean {
  return resolveThreadStatus({ thread, hiddenThreads: [], hasUnsubmittedDraft: false, rowStatus }).isWorking;
}

/** What the descendants of a thread are doing, as far as its row is concerned. */
type DescendantWork = "asks" | "working" | "idle";

/** One walk of the subtree: a descendant asking for input wins, then live work from one that has not failed. */
function descendantWork(
  childThreads: readonly PluginSidebarThread[],
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  isWorking: ThreadWorking,
): DescendantWork {
  const descendants = childSubtree(childThreads, childrenByParent);
  if (descendants.some(threadAsksForInput)) return "asks";
  return descendants.some((child) => !threadFailed(child) && isWorking(child)) ? "working" : "idle";
}

/**
 * Whether a thread, or anything under it, still has work running, by
 * `isWorking` (isThreadWorkingForDisplay with each thread's own row status).
 * Children are asked one by one rather than passed to bb as hidden threads,
 * so each answers with its own row status.
 *
 * The thread itself needing you, or failing, outranks its children's work:
 * that is the user's cue, so such a thread never counts as working here.
 * A descendant waiting on the user outranks the rest of the tree's work too:
 * its question shows only inside this tree, so the tree must stay in view.
 *
 * Decides both the compact row and the Working shelf.
 */
export function isWorkingTree(
  thread: PluginSidebarThread,
  childThreads: readonly PluginSidebarThread[],
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  isWorking: ThreadWorking,
): boolean {
  if (threadNeedsAttention(thread)) return false;
  const work = descendantWork(childThreads, childrenByParent, isWorking);
  return work !== "asks" && (isWorking(thread) || work === "working");
}

/**
 * A thread's unread result waits on work still running under it: its own
 * background agents, or any descendant at work. bb paints "unread-success"
 * only on a root whose finished turn is unread, so a failure, a question and
 * a failed send never match. A descendant asking for input ends the wait,
 * since that is the user's cue. The thread's own background commands never
 * hold it: a dev server runs forever.
 */
export function holdsUnreadForWork(
  thread: PluginSidebarThread,
  childThreads: readonly PluginSidebarThread[],
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  isWorking: ThreadWorking,
): boolean {
  if (thread.indicator !== "unread-success") return false;
  const work = descendantWork(childThreads, childrenByParent, isWorking);
  return work !== "asks" && (thread.activity.backgroundAgents > 0 || work === "working");
}

/**
 * The thread as its row draws it while its unread is held: read, with the
 * indicator bb would give it then. A thread with background agents of its own
 * reads "Agent"; any other shows its age, like a read parent whose children
 * work. Display only: bb's read state is untouched, so the unread shows again
 * once the work ends.
 */
export function withUnreadHeld(thread: PluginSidebarThread): PluginSidebarThread {
  const read = { ...thread, isUnread: false };
  const { indicator, label } = resolveThreadStatus({
    thread: read,
    hiddenThreads: [],
    hasUnsubmittedDraft: false,
    rowStatus: null,
  });
  return { ...read, indicator, indicatorLabel: label };
}
