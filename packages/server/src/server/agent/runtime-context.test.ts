import { describe, expect, test } from "vitest";
import { buildRuntimeHostSystemPrompt, describeSenderClient } from "./runtime-context.js";

describe("buildRuntimeHostSystemPrompt", () => {
  test("includes runtime host and sender-device guidance", () => {
    const prompt = buildRuntimeHostSystemPrompt("cloudtop");
    expect(prompt).toContain("Paseo runtime host: cloudtop.");
    expect(prompt).toContain("sender-device");
    expect(prompt).toContain("sender-locality");
  });

  test("returns empty string for blank host name", () => {
    expect(buildRuntimeHostSystemPrompt("   ")).toBe("");
  });
});

describe("describeSenderClient", () => {
  test("classifies unmodified native iOS app behind tailscale serve TLS proxy as remote iOS app", () => {
    expect(
      describeSenderClient({
        transport: "direct",
        peer: "loopback",
        clientType: "mobile",
        host: "cloudtop.tail10f85a.ts.net",
        origin: "https://cloudtop.tail10f85a.ts.net",
        appVersion: "0.17.1",
      }),
    ).toEqual({
      device: "iOS app",
      locality: "remote",
      clientType: "mobile",
      transport: "direct",
      host: "cloudtop.tail10f85a.ts.net",
      origin: "https://cloudtop.tail10f85a.ts.net",
      appVersion: "0.17.1",
    });
  });

  test("classifies Android React Native OkHttp client as Android app", () => {
    expect(
      describeSenderClient({
        transport: "direct",
        peer: "external",
        clientType: "mobile",
        userAgent: "okhttp/4.12.0",
        host: "cloudtop.tail10f85a.ts.net",
      }),
    ).toMatchObject({
      device: "Android app",
      locality: "remote",
    });
  });

  test("classifies mactop Chrome talking to cloudtop via local mactop UI as remote macOS Chrome", () => {
    expect(
      describeSenderClient({
        transport: "direct",
        peer: "loopback",
        clientType: "mobile",
        host: "cloudtop.tail10f85a.ts.net",
        origin: "http://127.0.0.1:6767",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      }),
    ).toMatchObject({
      device: "macOS Chrome",
      locality: "remote",
    });
  });

  test("classifies mactop Chrome talking to local mactop daemon as local macOS Chrome", () => {
    expect(
      describeSenderClient({
        transport: "direct",
        peer: "loopback",
        clientType: "mobile",
        host: "127.0.0.1:6767",
        origin: "http://127.0.0.1:6767",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      }),
    ).toMatchObject({
      device: "macOS Chrome",
      locality: "local",
    });
  });

  test("classifies iPhone Safari and iPad Safari", () => {
    expect(
      describeSenderClient({
        transport: "direct",
        peer: "loopback",
        clientType: "mobile",
        host: "cloudtop.tail10f85a.ts.net",
        origin: "https://cloudtop.tail10f85a.ts.net",
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
      }),
    ).toMatchObject({
      device: "iPhone Safari",
      locality: "remote",
    });

    expect(
      describeSenderClient({
        transport: "direct",
        peer: "loopback",
        clientType: "mobile",
        host: "cloudtop.tail10f85a.ts.net",
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
      }),
    ).toMatchObject({
      device: "iPad Safari",
      locality: "remote",
    });
  });

  test("classifies Desktop Electron via Electron UA or browserHost capability", () => {
    expect(
      describeSenderClient({
        transport: "direct",
        peer: "loopback",
        clientType: "mobile",
        host: "127.0.0.1:6767",
        origin: "http://localhost:6767",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Paseo/0.17.3 Chrome/136.0.0.0 Electron/44.2.0 Safari/537.36",
        hasBrowserHost: true,
      }),
    ).toMatchObject({
      device: "macOS Desktop",
      locality: "local",
    });

    expect(
      describeSenderClient({
        transport: "direct",
        peer: "loopback",
        clientType: "mobile",
        host: "cloudtop.tail10f85a.ts.net",
        hasBrowserHost: true,
      }),
    ).toMatchObject({
      device: "Desktop app",
      locality: "remote",
    });
  });

  test("classifies CLI, MCP, Hub, and relay clients", () => {
    expect(
      describeSenderClient({
        transport: "direct",
        peer: "loopback",
        clientType: "cli",
        host: "127.0.0.1:6767",
      }),
    ).toMatchObject({ device: "CLI", locality: "local" });

    expect(
      describeSenderClient({
        transport: "direct",
        peer: "local_ipc",
        clientType: "mcp",
      }),
    ).toMatchObject({ device: "MCP", locality: "local" });

    expect(
      describeSenderClient({
        transport: "hub",
        peer: "external",
        clientType: "hub",
      }),
    ).toMatchObject({ device: "Hub", locality: "remote" });

    expect(
      describeSenderClient({
        transport: "relay",
        peer: "external",
        clientType: "mobile",
      }),
    ).toMatchObject({ device: "iOS app", locality: "remote" });
  });
});
