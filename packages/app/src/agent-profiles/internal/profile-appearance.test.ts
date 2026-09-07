import { describe, expect, it } from "vitest";
import {
  resolveAgentProfileColor,
  resolveAgentProfileIconKey,
  resolveAgentProfileGlyphName,
} from "./profile-appearance";

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

  it.each(["claude", "codex", "antigravity", "claude-bedrock"])(
    "inherits the provider for %s profiles without an assigned icon",
    (provider) => {
      expect(resolveAgentProfileGlyphName(undefined, provider)).toEqual({
        kind: "provider",
        id: provider,
      });
      expect(resolveAgentProfileGlyphName("", provider)).toEqual({
        kind: "provider",
        id: provider,
      });
    },
  );

  it("preserves explicit icons instead of replacing them with the provider brand", () => {
    expect(resolveAgentProfileGlyphName("rocket", "codex")).toEqual({
      kind: "custom",
      id: "rocket",
    });
    expect(resolveAgentProfileGlyphName("gemini", "antigravity")).toEqual({
      kind: "custom",
      id: "gemini",
    });
    expect(resolveAgentProfileGlyphName("future-icon", "codex")).toEqual({ kind: "default" });
    expect(resolveAgentProfileGlyphName(undefined, undefined)).toEqual({ kind: "default" });
  });
});
