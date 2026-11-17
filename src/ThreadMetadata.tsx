import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";

export function ThreadLocation({ thread }: { thread: PluginSidebarThread }) {
  const branchName = thread.environment?.branchName;
  if (branchName) {
    const isWorktree = thread.environment?.isWorktree === true;
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
        <Icon
          name={isWorktree ? "FolderGit" : "GitBranch"}
          aria-label={isWorktree ? "Worktree branch" : "Branch"}
          className="size-3 shrink-0 text-muted-foreground/60"
        />
        <span className="truncate font-mono">{branchName}</span>
      </span>
    );
  }
  if (thread.host) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
        <Icon name="Computer" aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="truncate">{thread.host.name}</span>
      </span>
    );
  }
  return <span className="flex-1" />;
}
