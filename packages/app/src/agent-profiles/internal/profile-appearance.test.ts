import { describe, expect, it } from "vitest";
import { resolveAgentProfileColor, resolveAgentProfileIconKey } from "./profile-appearance";

describe("profile appearance", () => {
  it("accepts the Gemini brand icon for pinned profiles", () => {
    expect(resolveAgentProfileIconKey("gemini")).toBe("gemini");
  });

  it("preserves known icons and defaults unknown or missing profile icons", () => {
    expect(resolveAgentProfileIconKey("code")).toBe("code");
    expect(resolveAgentProfileIconKey("future-provider")).toBeNull();
    expect(resolveAgentProfileIconKey(undefined)).toBeNull();
  });

  it("defaults unknown profile colors", () => {
    expect(resolveAgentProfileColor("future-color")).toBe("none");
  });
});
