import pino from "pino";
import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { UsageSession } from "./usage-session.js";

test("lists reports from usage sources", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const requested: Array<{ forceRefresh?: boolean; reportIds?: string[] }> = [];
  const entry = {
    id: "fixture:one",
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: "fixture",
    sourceLabel: "Fixture",
    report: { status: "available" as const, windows: [] },
  };
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports(options) {
        requested.push({ forceRefresh: options.forceRefresh, reportIds: options.reportIds });
        options.onReport?.(entry);
        return [entry];
      },
      async listLegacyUsage() {
        return { fetchedAt: "2026-01-01T00:00:00.000Z", providers: [] };
      },
    },
    logger: pino({ level: "silent" }),
  });

  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "list" });
  expect(requested).toEqual([{ forceRefresh: undefined, reportIds: undefined }]);
  expect(emitted).toEqual([
    { type: "usage.list_reports.update", payload: { requestId: "list", report: entry } },
    { type: "usage.list_reports.response", payload: { requestId: "list", error: null } },
  ]);
});

test("surfaces a legacy usage-list failure as an rpc_error envelope", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports() {
        return [];
      },
      async listLegacyUsage(): Promise<never> {
        throw new Error("quota service down");
      },
    },
    logger: pino({ level: "silent" }),
  });
  await usage.handleLegacyList({ type: "provider.usage.list.request", requestId: "u1" });
  expect(emitted[0]).toMatchObject({
    type: "rpc_error",
    payload: { requestId: "u1", code: "provider_usage_list_failed" },
  });
});

test("request failures terminate with an error response and no updates", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    logger: pino({ level: "silent" }),
  });
  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "failed" });
  expect(emitted).toEqual([
    {
      type: "usage.list_reports.response",
      payload: { requestId: "failed", error: "Plugin runtime is unavailable" },
    },
  ]);
});

test("routed accounts replace the default-home report and preserve other providers", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const calls: unknown[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    logger: pino({ level: "silent" }),
    routedUsage: {
      async listRoutedUsage(agentId, forceRefresh) {
        calls.push([agentId, forceRefresh]);
        return {
          accounts: ["plus", "pro"].map((accountId) => ({
            providerId: "codex",
            accountId,
            displayName: accountId,
            status: "available" as const,
            planLabel: accountId,
            windows: [],
            fetchedAt: "2026-10-17T00:00:00.000Z",
          })),
          routing: {
            providerId: "codex",
            accountId: "plus",
            status: "active" as const,
            phase: "quota_wait",
            checkedAt: "2026-10-17T00:00:00.000Z",
          },
        };
      },
    },
    runtime: {
      async listUsageReports(options) {
        for (const sourceId of ["codex", "claude"])
          options.onReport?.({
            id: sourceId,
            sourceId,
            sourceLabel: sourceId,
            account: {},
            fetchedAt: "2026-10-17T00:00:00.000Z",
            report: { status: "available", windows: [] },
          });
        return [];
      },
      async listLegacyUsage() {
        return { fetchedAt: "", providers: [] };
      },
    },
  });
  await usage.handleListReports({
    type: "usage.list_reports.request",
    requestId: "r",
    agentId: "agent",
    forceRefresh: true,
  });
  expect(calls).toEqual([["agent", true]]);
  const updates = emitted.filter((event) => event.type === "usage.list_reports.update");
  expect(updates.map((event) => event.payload.report.id)).toEqual([
    "codex-router:plus",
    "codex-router:pro",
    "claude",
  ]);
  expect(updates[0].payload.report.report).toMatchObject({
    details: [{ label: "Current account", value: "plus · quota_wait" }],
  });
});
