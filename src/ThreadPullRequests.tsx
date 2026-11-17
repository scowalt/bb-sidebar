import { useState } from "react";
import { UrlLink, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useThreadPullRequests } from "./bb-sdk";
import { Icon, type IconName } from "./components/Icon";
import { cn } from "./lib/utils";
import { PR_TONE_TEXT, PullRequestBar } from "./PullRequestRail";
import { pullRequestCard, type PullRequestCardRow } from "./pull-request-cards";
import { PR_STATUS, rollupWords, summarizePullRequests, type PullRequestStatus } from "./pull-request-status";

const STATUS_ICON: Record<PullRequestStatus, IconName> = {
  checks_failed: "CircleX",
  conflicts: "CircleX",
  changes_requested: "Edit",
  checks_pending: "Clock",
  review_requested: "Search",
  ready: "GitPullRequest",
  draft: "Edit",
  unknown: "CircleQuestion",
  merged: "Check",
  closed: "CircleX",
};

/**
 * Every PR the thread opened, for the hover card: the bar, the rollup in
 * words, then open work first as stack trees, finished PRs after. Mounted
 * only while the card is open, which is what makes a settled thread's
 * lookup on demand.
 */
export function ThreadPullRequestDetails({ thread }: { thread: PluginSidebarThread }) {
  const pullRequests = useThreadPullRequests(thread.id, true);
  const [unfolded, setUnfolded] = useState(false);
  if (!pullRequests) return null;
  if (!pullRequests.entries.length) {
    if (pullRequests.scanned) return null;
    return (
      <div className="flex items-center gap-2 text-xs font-normal leading-4 text-muted-foreground">
        <Icon name="GitPullRequest" className="size-3.5 shrink-0" aria-hidden />
        <span>{pullRequests.scanFailed ? "Couldn't look for pull requests" : "Looking for pull requests…"}</span>
      </div>
    );
  }
  const summary = summarizePullRequests(pullRequests.entries);
  const card = pullRequestCard(pullRequests.entries, Date.now());
  const rows = unfolded && card.folded ? [...card.rows, ...card.folded.rows] : card.rows;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-xs font-normal leading-4 text-muted-foreground">
      <div className="flex items-center gap-2">
        <Icon name="GitPullRequest" className="size-3.5 shrink-0" aria-hidden />
        <span>Pull requests</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {card.merged} of {card.total} merged
        </span>
      </div>
      <PullRequestBar aria-hidden segments={summary.segments} className="h-[3px]" />
      <div className="truncate">
        {summary.rollup.map(({ status }, index) => (
          <span key={status}>
            {index ? <span className="text-muted-foreground/60"> · </span> : null}
            <span className={PR_TONE_TEXT[PR_STATUS[status].tone]}>{rollupWords(summary)[index]}</span>
          </span>
        ))}
      </div>
      <ul
        aria-label="Pull requests"
        className="pointer-events-auto flex max-h-[min(14rem,35dvh)] flex-col gap-1.5 overflow-y-auto rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {rows.map((row) => (
          <PullRequestRow key={row.entry.url} row={row} />
        ))}
      </ul>
      {card.folded && !unfolded ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setUnfolded(true);
          }}
          className="pointer-events-auto flex items-center gap-1 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="ChevronDown" className="size-3 shrink-0" aria-hidden />
          <span>{card.folded.label}</span>
        </button>
      ) : null}
    </div>
  );
}

function PullRequestRow({ row }: { row: PullRequestCardRow }) {
  const { entry, status, depth, ref, detail, alsoConflicts } = row;
  const tone = PR_STATUS[status].tone;
  const title = entry.facts?.title;
  const finished = status === "merged" || status === "closed" || status === "unknown";
  return (
    <li className="min-w-0" style={depth ? { paddingLeft: depth * 12 } : undefined} data-depth={depth}>
      <div className="flex min-w-0 items-start gap-1.5">
        {depth ? (
          <span aria-hidden className="mt-1 size-2 shrink-0 rounded-bl-sm border-b border-l border-border" />
        ) : null}
        <Icon name={STATUS_ICON[status]} className={cn("mt-px size-3.5 shrink-0", PR_TONE_TEXT[tone])} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <UrlLink
              href={entry.url}
              aria-label={`Open pull request ${ref}`}
              onClick={(event) => event.stopPropagation()}
              className={cn(
                "pointer-events-auto shrink-0 rounded-sm font-mono hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                PR_TONE_TEXT[tone],
              )}
            >
              {ref}
            </UrlLink>
            {title ? (
              <span className="truncate text-foreground/80" title={title}>
                {title}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
            {finished ? (
              <span className={cn("truncate", PR_TONE_TEXT[tone])}>
                {detail.charAt(0).toUpperCase() + detail.slice(1)}
              </span>
            ) : (
              <>
                <span className={cn("shrink-0", PR_TONE_TEXT[tone])}>{PR_STATUS[status].label}</span>
                <span aria-hidden className="-mx-0.5 shrink-0 text-muted-foreground/60">
                  ·
                </span>
                <span className={cn("truncate", status === "checks_failed" && PR_TONE_TEXT.alert)}>{detail}</span>
                {alsoConflicts ? <span className={cn("shrink-0", PR_TONE_TEXT.alert)}>conflicts</span> : null}
              </>
            )}
            {entry.facts?.additions != null && entry.facts.deletions != null ? (
              <span className="ml-auto shrink-0 tabular-nums">
                <span className={PR_TONE_TEXT.ready}>+{entry.facts.additions}</span>{" "}
                <span className={PR_TONE_TEXT.alert}>−{entry.facts.deletions}</span>
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}
