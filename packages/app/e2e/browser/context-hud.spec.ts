import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.use({
  e2eDaemonConfig: { agents: { skills: { selection: { mode: "custom", skills: [] } } } },
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`cold workspace route hydrates and shares context details at ${viewport.width}px`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "context-hud-",
      title: "Context HUD acceptance",
      initialPrompt: "emit 1 coalesced agent stream update for context HUD",
    });
    try {
      await openAgentRoute(page, session);
      const hud = page.getByTestId("agent-context-hud");
      const meter = hud.getByTestId("context-window-meter");
      await expect(meter).toBeVisible({ timeout: 30_000 });
      await expect(meter).toHaveText(/\d+%/);
      const box = await hud.boundingBox();
      expect(box?.y).toBeLessThan(100);
      if (viewport.width < 600) await meter.click();
      else await meter.hover();
      await expect(page.getByText("Context window", { exact: true })).toBeVisible();
      if (viewport.width < 600) await page.keyboard.press("Escape");
      else await page.mouse.move(0, 300);
      await expect(meter).toBeVisible();
      await page.screenshot({ path: `/tmp/context-hud-${viewport.width}.png` });
    } catch (error) {
      console.log("HUD failure before cleanup", await page.locator("body").innerText());
      await page.screenshot({ path: `/tmp/context-hud-failure-${viewport.width}.png` });
      throw error;
    } finally {
      await session.cleanup();
    }
  });
}
