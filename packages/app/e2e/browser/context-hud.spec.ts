import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.use({
  e2eDaemonConfig: { agents: { skills: { selection: { mode: "custom", skills: [] } } } },
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`context HUD stays visible and shares meter details at ${viewport.width}px`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const session = await seedMockAgentWorkspace({
      repoPrefix: "context-hud-",
      title: "Context HUD acceptance",
      initialPrompt: "emit 1 coalesced agent stream update for context HUD",
    });
    try {
      await openAgentRoute(page, session);
      await page.setViewportSize(viewport);
      const hud = page.getByTestId("agent-context-hud");
      const meter = hud.getByTestId("context-window-meter");
      await expect(meter).toBeVisible({ timeout: 30_000 });
      await expect(meter).toHaveText(/\d+%/);
      const box = await hud.boundingBox();
      expect(box?.y).toBeLessThan(100);
      await meter.hover();
      await expect(page.getByText("Context window", { exact: true })).toBeVisible();
      await page.mouse.move(0, 300);
      await expect(meter).toBeVisible();
      await page.screenshot({ path: `/tmp/context-hud-${viewport.width}.png` });
    } finally {
      await session.cleanup();
    }
  });
}
