import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderUsageTooltipSection } from "./tooltip-section";
import type { ProviderUsageListPayload } from "./types";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
let root: Root | undefined;
let container: HTMLDivElement | undefined;
function payload(): ProviderUsageListPayload {
  const stamp = new Date().toISOString();
  return {
    requestId: "test",
    fetchedAt: stamp,
    accountRouting: {
      providerId: "codex",
      accountId: "plus",
      status: "active",
      phase: "idle",
      checkedAt: stamp,
    },
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available",
        planLabel: "pro",
        windows: [],
        accounts: [
          {
            accountId: "plus",
            providerId: "codex",
            displayName: "plus",
            planLabel: "plus",
            status: "available",
            fetchedAt: stamp,
            windows: [
              {
                id: "short",
                label: "5-hour",
                usedPct: 20,
                remainingPct: 80,
                resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
              },
              { id: "weekly", label: "Weekly", usedPct: 60, remainingPct: 40 },
            ],
          },
          {
            accountId: "pro",
            providerId: "codex",
            displayName: "pro",
            planLabel: "pro",
            status: "available",
            fetchedAt: stamp,
            windows: [{ id: "weekly", label: "Weekly", usedPct: 50, remainingPct: 50 }],
          },
        ],
      },
    ],
  };
}
function render(data: ProviderUsageListPayload) {
  if (!root) {
    container = document.createElement("div");
    container.style.width = "320px";
    document.body.appendChild(container);
    root = createRoot(container);
  }
  // A fresh snapshot is intentional in this render harness.
  // oxlint-disable-next-line react-perf/jsx-no-new-object-as-prop
  const view = { kind: "ready" as const, payload: data, isRefreshing: false };
  act(() => root!.render(<ProviderUsageTooltipSection activeProviderId="codex" view={view} />));
  return container!;
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

it("shows separate account allowances, actual windows, resets and freshness", () => {
  const card = render(payload());
  expect(card.textContent).toContain("Current account: Plus");
  expect(card.textContent).toContain("80% remaining");
  expect(card.textContent).toContain("40% remaining");
  expect(card.textContent).toContain("50% remaining");
  expect(card.textContent).toContain("5-hour");
  expect(card.textContent).toContain("resets 3h");
  expect(card.textContent).toContain("Updated just now");
  expect(
    card.querySelector<HTMLElement>('[data-testid="provider-account-usage"]')!.scrollWidth,
  ).toBeLessThanOrEqual(320);
});
it("follows an actual route change without changing the two account balances", () => {
  const data = payload();
  render(data);
  data.accountRouting = { ...data.accountRouting!, accountId: "pro", phase: "quota_wait" };
  const card = render(data);
  expect(card.textContent).toContain("Current account: Pro · Waiting for quota");
  expect(card.textContent).not.toContain("Current account: Plus");
  expect(card.textContent).toContain("80% remaining");
});
it("keeps account errors visible without showing an invented available balance", () => {
  const data = payload();
  data.providers[0].accounts![0] = {
    ...data.providers[0].accounts![0],
    status: "unavailable",
    windows: [],
    fetchedAt: new Date(Date.now() - 120_000).toISOString(),
  };
  data.accountRouting = { ...data.accountRouting!, status: "unknown", accountId: null };
  const card = render(data);
  expect(card.textContent).toContain("Current account unavailable");
  expect(card.textContent).toContain("Unavailable");
  expect(card.textContent).toContain("Updated 2m ago");
  expect(card.textContent).not.toContain("80% remaining");
  expect(card.textContent).toContain("50% remaining");
});
it("keeps ordinary provider usage available on hosts without a router", () => {
  const data = payload();
  delete data.providers[0].accounts;
  delete data.accountRouting;
  const card = render(data);
  expect(card.textContent).toContain("Codex");
  expect(card.textContent).not.toContain("Current account");
});
