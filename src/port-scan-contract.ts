import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  openPortSchema,
  ownedPortTargetSchema,
  closePortsResultSchema,
  portCloseScopeSchema,
  pullRequestFactsSchema,
} from "./contract";

/**
 * One answer per URL. A found PR is fully described; a failed one names why,
 * so the server keeps its last facts and backs off. A merged or closed PR
 * costs one forge call; an open one three, and any of them failing fails the
 * whole PR rather than deriving a status from half the facts.
 */
export const pullRequestLookupResultSchema = z.discriminatedUnion("outcome", [
  z.object({ url: z.string(), outcome: z.literal("found"), facts: pullRequestFactsSchema }),
  z.object({
    url: z.string(),
    outcome: z.literal("failed"),
    reason: z.enum(["missing_tool", "unauthorized", "not_found", "timeout", "error"]),
  }),
]);
export type PullRequestLookupResult = z.infer<typeof pullRequestLookupResultSchema>;

const rootSchema = z.object({ environmentId: z.string(), path: z.string().min(1) });
export type PortRoot = z.infer<typeof rootSchema>;
export const portScanContract = defineRpcContract({
  timeZone: {
    input: z.object({}).strict(),
    output: z.object({ timeZone: z.string().nullable() }),
  },
  resolveRoots: {
    input: z.object({ roots: z.array(rootSchema).max(10000) }),
    output: z.object({ roots: z.array(z.object({ environmentId: z.string(), path: z.string().min(1).nullable() })) }),
  },
  closeOwnedPorts: {
    // Optional so an older host, which drops the field, falls back to the
    // stricter thread-owned check instead of failing the call.
    input: z.object({
      root: rootSchema,
      threadId: z.string().min(1),
      ports: z.array(ownedPortTargetSchema).min(1).max(1000),
      scope: portCloseScopeSchema.optional(),
    }),
    output: closePortsResultSchema,
  },
  // The plugin's only host entry, so it also runs `gh` and `tea` where the
  // thread's workspace, and so its sign-in, lives. A new name rather than a
  // wider `pullRequests` (the method before 0.4): an older host answering the
  // old shape would otherwise derive to a false "ready"; a host without the
  // method fails the call, and the server backs off as for any failure.
  lookUpPullRequests: {
    input: z.object({ urls: z.array(z.string().url()).min(1).max(20) }),
    output: z.object({ pullRequests: z.array(pullRequestLookupResultSchema) }),
    experimental_retryable: true,
  },
  scan: {
    input: z.object({ roots: z.array(rootSchema).max(10000) }),
    output: z.object({
      ports: z.array(
        openPortSchema.extend({
          environmentId: z.string(),
        }),
      ),
    }),
  },
});
