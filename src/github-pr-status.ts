// The bundled GitHub PR Status plugin owns pull request data for each
// environment's checked-out branch. Its `pullRequests` method is a keyed read:
// environment ids in, one row per id out (`available` with the PR, `absent`,
// or `unavailable` when the machine is offline or `gh` failed). The server
// reads it for auto-settle and to discover a worktree's branch PR;
// `bb plugin rpc inspect bb--github-pr-status pullRequests` prints the schema.

export const GITHUB_PR_STATUS_PLUGIN_ID = "bb--github-pr-status";

/** `pullRequests` accepts at most this many environment ids per call. */
export const MAX_PULL_REQUEST_KEYS = 200;
