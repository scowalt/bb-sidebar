import { z } from "zod";
import type { PullRequestEntry, PullRequestFacts, ThreadPullRequests } from "./pull-request-status";

export const pullRequestFactsSchema = z.object({
  title: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  checks: z
    .object({
      total: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      failing: z.array(z.string()),
    })
    .nullable(),
  review: z.enum(["changes_requested", "review_requested", "approved"]).nullable(),
  head: z.string().nullable(),
  base: z.string().nullable(),
  mergedAt: z.string().nullable(),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
}) satisfies z.ZodType<PullRequestFacts>;
const pullRequestEntrySchema = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number().int(),
  facts: pullRequestFactsSchema.nullable(),
}) satisfies z.ZodType<PullRequestEntry>;
export const threadPullRequestsSchema = z.object({
  entries: z.array(pullRequestEntrySchema),
  scanned: z.boolean(),
  scanFailed: z.boolean(),
}) satisfies z.ZodType<ThreadPullRequests>;
