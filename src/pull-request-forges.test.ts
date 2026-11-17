import { describe, expect, it } from "vitest";
import {
  confirmGiteaConflict,
  createdPullRequestUrls,
  parseGhFacts,
  parseGiteaFacts,
  parsePullRequestUrl,
} from "./pull-request-forges";
import { facts } from "./pull-request-status.test";

function command(command: string, aggregatedOutput: string, type = "item/completed") {
  return { type, data: { item: { type: "commandExecution", command, aggregatedOutput } } };
}
const gitea = (number: number, repo = "o/r") => `https://git.example.com/${repo}/pulls/${number}`;
const github = (number: number, repo = "o/r") => `https://github.com/${repo}/pull/${number}`;

describe("parsePullRequestUrl", () => {
  it("tells GitHub from Gitea by the origin", () => {
    expect(parsePullRequestUrl(github(12))).toEqual({
      forge: "github",
      origin: "https://github.com",
      repo: "o/r",
      number: 12,
    });
    expect(parsePullRequestUrl("http://gitea.local:3000/Own.er/re-po/pulls/7")).toEqual({
      forge: "gitea",
      origin: "http://gitea.local:3000",
      repo: "Own.er/re-po",
      number: 7,
    });
    expect(parsePullRequestUrl("https://github.com/o/r/pull/new/a")).toBeNull();
    expect(parsePullRequestUrl("https://git.example.com/o/r/issues/4")).toBeNull();
  });
});

describe("createdPullRequestUrls", () => {
  it("collects PRs printed by gh pr create, oldest first and without repeats", () => {
    expect(
      createdPullRequestUrls([
        command(
          "git push -u origin a && gh pr create --fill",
          "remote: Create a pull request for 'a' on GitHub by visiting:\nremote:   https://github.com/o/r/pull/new/a\nhttps://github.com/o/r/pull/12",
        ),
        command(
          "gh pr create --base main",
          'a pull request for branch "b" into branch "main" already exists:\nhttps://github.com/o/r/pull/13',
        ),
        command("gh  pr   create", github(12)),
      ]),
    ).toEqual([github(12), github(13)]);
  });

  it("finds a create wherever a shell runs it", () => {
    expect(
      createdPullRequestUrls([
        command('/bin/zsh -lc "gh pr create --base main"', github(1)),
        command("/bin/zsh -c 'gh pr create --fill'", github(2)),
        command("git push -u origin a\n gh pr create -R o/r", github(3)),
        command(
          "cat > body.md <<'EOF'\nText\nEOF\ngit push && GH_PROMPT_DISABLED=1 /opt/homebrew/bin/gh pr create",
          github(4),
        ),
        command("url=$(gh pr create --fill); echo $url", github(5)),
        command('zsh -lc "tea pr create --repo o/r --title x"', gitea(6)),
      ]),
    ).toEqual([1, 2, 3, 4, 5].map((number) => github(number)).concat(gitea(6)));
  });

  it("accepts the tea commands that write a PR", () => {
    expect(
      createdPullRequestUrls([
        command(
          'cd $BB_THREAD_STORAGE/r && git push -u origin b && tea pr create --repo o/r --base main --head b --title "t" --description "$(cat body.md)"',
          `${gitea(16575)}${gitea(16575)}\n`,
        ),
        command(
          "cat > body.md <<'EOF'\n## Why\nEOF\ntea pulls create --repo o/r --title t --description-file body.md",
          gitea(2),
        ),
        command("tea api -X POST repos/o/r/pulls -d @body.json | jq -r '.number, .html_url'", `3\n${gitea(3)}\n`),
        command(`tea api -X PATCH repos/o/r/pulls/12 -d '{"base":"main"}'`, `{"html_url":"${gitea(12)}"}`),
        command("tea api --method POST 'repos/o/r/pulls' -d @f", gitea(5)),
        command("tea pr c --repo o/r", gitea(8)),
        command("tea api -X POST -H 'Accept: application/json' --login work repos/o/r/pulls -d @f", gitea(9)),
        command("tea api repos/o/r/pulls/12 --method=PATCH -d @f", gitea(12)),
        command("tea api -XPOST /api/v1/repos/o/r/pulls -f title=t", gitea(13)),
      ]),
    ).toEqual([gitea(16575), gitea(2), gitea(3), gitea(12), gitea(5), gitea(8), gitea(9), gitea(13)]);
  });

  it("finds creates behind timeout, inside function bodies and loops, and with shell variables in the path", () => {
    expect(
      createdPullRequestUrls([
        command(
          "git push -q -u origin HEAD 2>&1 | tail -3; timeout 60 tea pulls create --title t --description-file - <<'EOF'\nbody\nEOF",
          `\x1b]8;id=1;${gitea(413)}\x07${gitea(413)}\x1b]8;;\x07\n`,
        ),
        command(
          `mk() { tea api -X POST "repos/o/$1/pulls" -d "$(jq -n '{}')" | jq -r '.html_url'; }\nmk r "t"\nmk other "t"`,
          `${gitea(1)}\n${gitea(2, "o/other")}\n`,
        ),
        command(
          `R=repos/o/r; for n in 3 4; do tea api -X PATCH $R/pulls/$n -d @patch.json | jq -r .html_url; done`,
          `${gitea(3)}\n${gitea(4)}\n`,
        ),
        command("R=repos/o/r; tea api -X POST $R/pulls -f title=t -f head=h -f base=main", gitea(5)),
        command(
          "python3 -c 'x' > pr.json && tea api -X POST repos/$REPO/pulls -d @pr.json > out.json && cat out.json",
          gitea(6),
        ),
      ]),
    ).toEqual([gitea(413), gitea(1), gitea(2, "o/other"), gitea(3), gitea(4), gitea(5), gitea(6)]);
  });

  it("holds a command that names its repo to that repo, and a PATCH to that PR", () => {
    expect(
      createdPullRequestUrls([
        // A PR body that links another repo's PR is printed back with the create.
        command("tea pr create --repo o/r --title t", `${gitea(1)}\nSee also ${gitea(40, "o/other")}`),
        command("gh pr create -R o/r --fill", `${github(2)}\n${github(41, "o/other")}`),
        command(`tea api -X PATCH repos/o/r/pulls/12 -d '{"base":"main"}'`, `${gitea(12)}\n${gitea(13)}`),
        command("tea api -X POST repos/o/r/pulls -d @f", `${gitea(14)}\n${gitea(15, "o/other")}`),
        command("tea pr create --title t", `${gitea(16)}\n${gitea(17, "o/other")}`),
      ]),
    ).toEqual([gitea(1), github(2), gitea(12), gitea(14), gitea(16), gitea(17, "o/other")]);
  });

  it("ignores commands that only mention a create, or write something else", () => {
    expect(
      createdPullRequestUrls([
        command('bb thread search "gh pr create" --json', github(1)),
        command('bb thread search "tea pr create" --json', gitea(1)),
        command('bb thread search "how do tea pr create" --json', gitea(1)),
        command('rg "then gh pr create" ~/logs', github(1)),
        command('echo "(gh pr create)"', github(1)),
        command("tea api repos/o/r/pulls/12 # last set with -X PATCH", gitea(12)),
        command(`tea api -X POST repos/o/r/issues/12/comments -d '{"body":"see repos/o/r/pulls/12"}'`, gitea(12)),
        command(`tea api -X POST -d '{"base":"repos/o/r/pulls"}' repos/o/r/issues`, gitea(12)),
        command("bb thread log thr_a --json | python3 -c \"\nif 'tea pr create' in s: print(s)\"", gitea(2)),
        command("grep -rn 'opened with `gh pr create`' CHANGELOG.md", github(3)),
        command("tea api -X POST repos/o/r/pulls/12/merge", gitea(12)),
        command("tea api -X POST repos/o/r/pulls/12/reviews -d @f", gitea(12)),
        command("tea api -X POST repos/o/r/pulls/12/requested_reviewers -d @f", gitea(12)),
        command("tea api -X POST repos/o/r/issues/12/comments -d @f", gitea(12)),
        command("tea api repos/o/r/pulls/12", gitea(12)),
        command("tea pr list --repo o/r", gitea(4)),
        command("tea pr view 5", gitea(5)),
        command("gh pr view 7", github(7)),
        command("gh pr create", github(8), "item/started"),
        {
          type: "item/completed",
          data: { item: { type: "agentMessage", text: `Opened ${github(9)}` } },
        },
        { type: "item/completed", data: null },
      ]),
    ).toEqual([]);
  });
});

describe("parseGhFacts", () => {
  const view = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      additions: 2109,
      baseRefName: "main",
      deletions: 498,
      headRefName: "feat/thread-interactions",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergedAt: null,
      number: 6,
      reviewDecision: "",
      state: "OPEN",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "StatusContext", context: "ci/lint", state: "SUCCESS" },
      ],
      title: "Improve thread interactions",
      url: "https://github.com/o/r/pull/6",
      ...overrides,
    });

  it("maps gh's view onto facts", () => {
    expect(parseGhFacts(view())).toEqual({
      title: "Improve thread interactions",
      state: "open",
      draft: false,
      mergeable: true,
      checks: { total: 2, passed: 2, pending: 0, failing: [] },
      review: null,
      head: "feat/thread-interactions",
      base: "main",
      mergedAt: null,
      additions: 2109,
      deletions: 498,
    });
  });

  it("reads check runs and status contexts, failing, pending and passing", () => {
    const facts = parseGhFacts(
      view({
        statusCheckRollup: [
          { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "FAILURE" },
          { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
          { __typename: "StatusContext", context: "deploy", state: "PENDING" },
          { __typename: "StatusContext", context: "scan", state: "ERROR" },
        ],
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "CONFLICTING",
      }),
    );
    expect(facts).toMatchObject({
      checks: { total: 5, passed: 1, pending: 2, failing: ["unit", "scan"] },
      review: "changes_requested",
      mergeable: false,
    });
  });

  it("maps states, drafts, review decisions and the absence of checks", () => {
    expect(
      parseGhFacts(view({ state: "MERGED", mergedAt: "2026-10-04T13:13:16Z", mergeable: "UNKNOWN" })),
    ).toMatchObject({
      state: "merged",
      mergedAt: "2026-10-04T13:13:16Z",
      mergeable: null,
    });
    expect(parseGhFacts(view({ state: "CLOSED" }))?.state).toBe("closed");
    expect(parseGhFacts(view({ isDraft: true, reviewDecision: "REVIEW_REQUIRED" }))).toMatchObject({
      draft: true,
      review: "review_requested",
    });
    expect(parseGhFacts(view({ reviewDecision: "APPROVED", statusCheckRollup: [] }))).toMatchObject({
      review: "approved",
      checks: null,
    });
    expect(parseGhFacts("not json")).toBeNull();
    expect(parseGhFacts(JSON.stringify({ message: "Not Found" }))).toBeNull();
  });
});

describe("parseGiteaFacts", () => {
  // Shapes of `tea api repos/o/r/pulls/N`, `…/commits/<sha>/status` and
  // `…/pulls/N/reviews` on Gitea 1.24, trimmed to the fields read.
  const pull = (overrides: Record<string, unknown> = {}) => ({
    id: 57209,
    number: 1148,
    title: "feat(customers): show status columns",
    state: "open",
    merged: false,
    merged_at: null,
    draft: false,
    mergeable: true,
    html_url: "https://git.example.com/o/r/pulls/1148",
    additions: 1307,
    deletions: 116,
    requested_reviewers: [],
    head: { ref: "bb/status-columns", sha: "660444176ce20c5652bb9e5598ef094dda25ae41" },
    base: { ref: "main", sha: "39e165589e1177025f4eb2562a51b35c41a0d8dc" },
    ...overrides,
  });
  const status = (statuses: Array<{ context: string; status: string }>) => ({
    state: statuses.some((entry) => entry.status === "failure") ? "failure" : "success",
    sha: "660444176ce20c5652bb9e5598ef094dda25ae41",
    total_count: statuses.length,
    statuses: statuses.map((entry) => ({ ...entry, description: "", target_url: "" })),
  });
  const review = (login: string, state: string, submitted_at: string, extra: Record<string, unknown> = {}) => ({
    id: 1,
    state,
    submitted_at,
    dismissed: false,
    stale: false,
    official: false,
    user: { login },
    ...extra,
  });

  it("maps an open PR with its checks and reviews", () => {
    expect(
      parseGiteaFacts(
        pull(),
        status([
          { context: "PR Title / pr-title (pull_request)", status: "success" },
          { context: "PR Backend Tests / C# full suite (pull_request)", status: "failure" },
          { context: "PR Format / format (pull_request)", status: "pending" },
          { context: "nightly (pull_request)", status: "skipped" },
        ]),
        [review("lore-bot", "COMMENT", "2026-11-15T22:45:17Z")],
      ),
    ).toEqual({
      title: "feat(customers): show status columns",
      state: "open",
      draft: false,
      mergeable: true,
      checks: { total: 4, passed: 2, pending: 1, failing: ["PR Backend Tests / C# full suite (pull_request)"] },
      review: null,
      head: "bb/status-columns",
      base: "main",
      mergedAt: null,
      additions: 1307,
      deletions: 116,
    });
  });

  it("reads merged and closed PRs without status or reviews", () => {
    expect(
      parseGiteaFacts(pull({ state: "closed", merged: true, merged_at: "2026-11-16T03:01:46Z" }), null, null),
    ).toMatchObject({
      state: "merged",
      mergedAt: "2026-11-16T03:01:46Z",
      checks: null,
      review: null,
    });
    expect(parseGiteaFacts(pull({ state: "closed" }), null, null)?.state).toBe("closed");
    expect(parseGiteaFacts(pull({ draft: true, mergeable: null }), status([]), [])).toMatchObject({
      draft: true,
      mergeable: null,
      checks: null,
    });
  });

  it("takes each reviewer's latest review, skipping dismissed ones and comments", () => {
    const reviews = [
      review("ana", "REQUEST_CHANGES", "2026-11-10T10:00:00Z"),
      review("ana", "APPROVED", "2026-11-11T10:00:00Z"),
      review("bo", "REQUEST_CHANGES", "2026-11-12T10:00:00Z", { dismissed: true }),
      review("cy", "COMMENT", "2026-11-13T10:00:00Z"),
    ];
    expect(parseGiteaFacts(pull(), status([]), reviews)?.review).toBe("approved");
    expect(
      parseGiteaFacts(pull(), status([]), [...reviews, review("bo", "REQUEST_CHANGES", "2026-11-14T10:00:00Z")])
        ?.review,
    ).toBe("changes_requested");
    expect(parseGiteaFacts(pull(), status([]), [review("dee", "REQUEST_REVIEW", "2026-11-14T10:00:00Z")])?.review).toBe(
      "review_requested",
    );
    expect(parseGiteaFacts(pull({ requested_reviewers: [{ login: "lore-bot" }] }), status([]), [])?.review).toBe(
      "review_requested",
    );
  });

  it("rejects what is not a pull request", () => {
    expect(
      parseGiteaFacts({ message: "not found", url: "https://git.example.com/api/swagger" }, null, null),
    ).toBeNull();
    expect(parseGiteaFacts(null, null, null)).toBeNull();
  });
});

describe("confirmGiteaConflict", () => {
  const conflicting = facts({ mergeable: false });
  const clean = facts({ mergeable: true });

  it("withholds the first `mergeable: false`, since Gitea also says it while still checking", () => {
    expect(confirmGiteaConflict({ facts: null, unconfirmed: false }, conflicting)).toEqual({
      facts: { ...conflicting, mergeable: null },
      unconfirmed: true,
    });
    expect(confirmGiteaConflict({ facts: clean, unconfirmed: false }, conflicting)).toEqual({
      facts: { ...conflicting, mergeable: null },
      unconfirmed: true,
    });
  });

  it("shows the conflict once two lookups in a row agree, and keeps showing it", () => {
    expect(
      confirmGiteaConflict({ facts: { ...conflicting, mergeable: null }, unconfirmed: true }, conflicting),
    ).toEqual({ facts: conflicting, unconfirmed: false });
    expect(confirmGiteaConflict({ facts: conflicting, unconfirmed: false }, conflicting)).toEqual({
      facts: conflicting,
      unconfirmed: false,
    });
  });

  it("passes every other answer through and forgets an unconfirmed one", () => {
    expect(confirmGiteaConflict({ facts: null, unconfirmed: true }, clean)).toEqual({
      facts: clean,
      unconfirmed: false,
    });
    const unknown = facts({ mergeable: null });
    expect(confirmGiteaConflict({ facts: conflicting, unconfirmed: false }, unknown)).toEqual({
      facts: unknown,
      unconfirmed: false,
    });
    const merged = facts({ state: "merged", mergeable: false });
    expect(confirmGiteaConflict({ facts: null, unconfirmed: false }, merged)).toEqual({
      facts: merged,
      unconfirmed: false,
    });
  });
});
