import type { HTMLAttributes, MouseEvent } from "react";
import { useThreadPullRequests } from "./bb-sdk";
import { useInboxSettledThreadIds } from "./InboxContext";
import { Tooltip } from "./components/Tooltip";
import { cn } from "./lib/utils";
import { pullRequestRef } from "./pull-request-cards";
import {
  describePullRequests,
  orderPullRequests,
  PR_STATUS,
  pullRequestStatus,
  summarizePullRequests,
  type PullRequestEntry,
  type PullRequestTone,
  type RailSegment,
} from "./pull-request-status";

const PR_TONE_BG: Record<PullRequestTone, string> = {
  alert: "bg-[color:var(--bb-sidebar-pr-alert)]",
  pending: "bg-[color:var(--bb-sidebar-pr-pending)]",
  review: "bg-[color:var(--bb-sidebar-pr-review)]",
  ready: "bg-[color:var(--bb-sidebar-pr-ready)]",
  draft: "bg-muted-foreground/50",
  unknown: "bg-muted-foreground/25",
  merged: "bg-[color:var(--bb-sidebar-pr-merged)]",
  closed: "bg-[color:var(--bb-sidebar-pr-closed)]",
};

export const PR_TONE_TEXT: Record<PullRequestTone, string> = {
  alert: "text-[color:var(--bb-sidebar-pr-alert)]",
  pending: "text-[color:var(--bb-sidebar-pr-pending)]",
  review: "text-[color:var(--bb-sidebar-pr-review)]",
  ready: "text-[color:var(--bb-sidebar-pr-ready)]",
  draft: "text-muted-foreground/60",
  unknown: "text-muted-foreground",
  merged: "text-[color:var(--bb-sidebar-pr-merged)]",
  closed: "text-[color:var(--bb-sidebar-pr-closed)]",
};

const RAIL_POSITION = {
  card: "inset-x-2.5 bottom-1 h-[3px]",
  grid: "inset-x-2.5 bottom-0.5 h-[3px]",
  slim: "inset-x-2.5 bottom-0.5 h-0.5",
  child: "bottom-0.5 left-6 right-2 h-0.5",
} as const;
type RailLayout = keyof typeof RAIL_POSITION;

function Segment({ segment }: { segment: RailSegment }) {
  return (
    <span
      data-status={segment.status}
      style={{ flexGrow: segment.span }}
      className={cn("min-w-0 basis-0 rounded-full", PR_TONE_BG[PR_STATUS[segment.status].tone])}
    />
  );
}

export function PullRequestBar({
  segments,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { segments: readonly RailSegment[] }) {
  return (
    <span {...props} className={cn("flex gap-0.5", className)}>
      {segments.map((segment) => (
        <Segment key={segment.key} segment={segment} />
      ))}
    </span>
  );
}

/** A row's pull requests while it is on screen and live; a Settled thread is never watched. */
function useRowPullRequests(threadId: string, visible: boolean) {
  const settled = useInboxSettledThreadIds();
  return useThreadPullRequests(threadId, visible && settled !== null && !settled.has(threadId));
}

export function PullRequestRail({
  threadId,
  visible,
  layout,
}: {
  threadId: string;
  visible: boolean;
  layout: RailLayout;
}) {
  const pullRequests = useRowPullRequests(threadId, visible);
  if (!pullRequests?.entries.length) return null;
  const summary = summarizePullRequests(pullRequests.entries);
  return (
    <PullRequestBar
      role="img"
      aria-label={describePullRequests(summary)}
      data-settle-fade=""
      segments={summary.segments}
      className={cn("pointer-events-none absolute", RAIL_POSITION[layout])}
    />
  );
}

function openRow(event: MouseEvent<HTMLElement>) {
  const link = event.currentTarget
    .closest("[data-parent-card]")
    ?.querySelector<HTMLAnchorElement>("a[data-sidebar-thread-id]");
  if (!link) return;
  const { button, ctrlKey, metaKey, shiftKey, altKey } = event.nativeEvent;
  link.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button,
      ctrlKey,
      metaKey,
      shiftKey,
      altKey,
    }),
  );
}

function SinglePullRequest({ entry }: { entry: PullRequestEntry }) {
  const status = pullRequestStatus(entry);
  const label = PR_STATUS[status].label;
  return (
    <Tooltip label={entry.facts ? `${entry.facts.title}\n${label}` : label} className="whitespace-pre-line">
      <a
        href={entry.url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "pointer-events-auto relative shrink-0 font-mono hover:underline",
          PR_TONE_TEXT[PR_STATUS[status].tone],
        )}
      >
        #{entry.number}
      </a>
    </Tooltip>
  );
}

export function PullRequestCount({ threadId, visible }: { threadId: string; visible: boolean }) {
  const pullRequests = useRowPullRequests(threadId, visible);
  const entries = pullRequests?.entries ?? [];
  if (entries.length === 0) return null;
  if (entries.length === 1) return <SinglePullRequest entry={entries[0]!} />;
  const summary = summarizePullRequests(entries);
  const tone = summary.worst ? PR_STATUS[summary.worst].tone : summary.merged ? "merged" : "closed";
  const lines = orderPullRequests(entries).map(({ entry, status }) =>
    `${pullRequestRef(entry, entries)} ${PR_STATUS[status].label}: ${entry.facts?.title ?? ""}`.trimEnd(),
  );
  return (
    <Tooltip label={lines.join("\n")} className="whitespace-pre-line">
      <span
        onClick={openRow}
        className={cn(
          "pointer-events-auto relative shrink-0 cursor-pointer font-mono tabular-nums",
          PR_TONE_TEXT[tone],
        )}
      >
        {summary.merged}/{summary.total}
        <span className="sr-only"> pull requests merged</span>
      </span>
    </Tooltip>
  );
}
