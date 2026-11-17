import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  openPortSchema,
  ownedPortTargetSchema,
  closePortsResultSchema,
  portCloseScopeSchema,
  pullRequestFactsSchema,
} from "./contract";

export const pullRequestLookupResultSchema = z.discriminatedUnion("outcome", [
  z.object({ url: z.string(), outcome: z.literal("found"), facts: pullRequestFactsSchema }),
  z.object({
    url: z.string(),
    outcome: z.literal("failed"),
    reason: z.enum(["missing_tool", "unauthorized", "not_found", "timeout", "error"]),
  }),
]);
export type PullRequestLookupResult = z.infer<typeof pullRequestLookupResultSchema>;
export const PULL_REQUEST_HOST_CALL_TIMEOUT_MS = 30_000;

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
