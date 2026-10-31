import { expect, test } from "../support/fixtures";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: { skills: { selection: { mode: "custom", skills: [] } } },
  },
  e2eDaemonEnvironment: { PASEO_PASSWORD: "" },
});

test("retains error history but marks it historical after real resumed output", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "error-recovery-",
    title: "Recovery evidence",
    model: "ten-second-stream",
  });
  try {
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await submitMessage(page, "Emit a synthetic turn failure.");
    await expect(page.getByText("[System Error] Requested mock provider failure")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("Currently blocked — no later execution output confirmed."),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("blocked.png") });
    await submitMessage(page, "emit 1 coalesced agent stream updates for recovery verification.");
    await expect(
      page.getByText(
        "Historical error — newer assistant or completed tool output is present. Task completion is not implied.",
      ),
    ).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("[System Error] Requested mock provider failure")).toBeVisible();
    await page.screenshot({ path: info.outputPath("recovered.png") });
  } finally {
    await session.cleanup();
  }
});
