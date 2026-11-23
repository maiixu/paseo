import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, it } from "vitest";
import { createAntigravityProvider } from "./provider.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function launchAgent(source: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-acp-"));
  directories.push(directory);
  const executable = path.join(directory, "agy.cjs");
  await writeFile(executable, source);
  return {
    directory,
    launch: {
      command: process.execPath,
      args: [executable, "acp", "--disable-telemetry"],
      env: { CAPTURE: path.join(directory, "requests.ndjson") },
    },
  };
}

it("reports a CLI without the acp subcommand as unavailable", async () => {
  const { launch } = await launchAgent(`
    process.stderr.write("Unknown command: acp");
    process.exitCode = 1;
  `);
  const provider = createAntigravityProvider();
  expect(provider.command?.slice(0, 2)).toEqual(["agy", "acp"]);
  expect(await provider.status!({ launch })).toMatchObject({
    available: false,
    diagnostic: expect.stringContaining("1.5.0"),
  });
});

const minimalAcpAgent = `
  const { createInterface } = require("node:readline");
  createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, method } = JSON.parse(line);
    if (method === "initialize")
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
  });
`;

describe("diagnostic", () => {
  it("says agy runs outside an SSH session when the daemon has no SSH variables", async () => {
    const { launch } = await launchAgent(minimalAcpAgent);
    expect(await createAntigravityProvider().status!({ launch })).toEqual({
      available: true,
      diagnostic: "SSH session: no\nSign-in: can differ from agy over SSH",
    });
  });

  it.each(["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])(
    "says agy runs in an SSH session when the daemon has %s",
    async (variable) => {
      const { launch } = await launchAgent(minimalAcpAgent);
      const env = { ...launch.env, [variable]: "set" };
      expect(await createAntigravityProvider().status!({ launch: { ...launch, env } })).toEqual({
        available: true,
        diagnostic: `SSH session: yes (${variable})\nSign-in: can differ from agy outside SSH`,
      });
    },
  );

  it("says whether agy runs in an SSH session when ACP does not start", async () => {
    const { launch } = await launchAgent(`process.exit(1);`);
    const env = { ...launch.env, SSH_CONNECTION: "set" };
    expect(await createAntigravityProvider().status!({ launch: { ...launch, env } })).toEqual({
      available: false,
      diagnostic: [
        "Antigravity ACP did not start. Install Antigravity 1.5.0 or later. If you override the command, include the acp subcommand.",
        "SSH session: yes (SSH_CONNECTION)",
        "Sign-in: can differ from agy outside SSH",
      ].join("\n"),
    });
  });
});

it("publishes Antigravity skills separately from built-in commands", async () => {
  const { directory, launch } = await launchAgent(`
    const { createInterface } = require("node:readline");
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method } = JSON.parse(line);
      if (method === "initialize") {
        send({ id, result: { protocolVersion: 1 } });
      }
      if (method === "session/new") {
        send({ id, result: { sessionId: "native", modes: {
          currentModeId: "default", availableModes: [{ id: "default", name: "Default" }],
        } } });
        send({ method: "session/update", params: { sessionId: "native", update: {
          sessionUpdate: "available_commands_update",
          availableCommands: ["goal", "compact", "schedule", "browser", "plan", "grill-me",
            "teamwork", "learn", "boost", "agy-customizations", "antigravity-guide", "diagnose"]
            .map(name => ({ name, description: name })),
        } } });
      }
    });
  `);
  const connection = await createAntigravityProvider().connect({
    launch,
    versions: [1],
    capabilities: [],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open",
      requestId: "new",
      sessionId: "test",
      history: "skip",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
    });
    await expect
      .poll(() =>
        events.find(
          (event) => event.type === "session.commands" || event.type === "request.failed",
        ),
      )
      .toMatchObject({ type: "session.commands" });
    await expect
      .poll(() => events.find((event) => event.type === "session.commands")?.commands)
      .toEqual([
        ...[
          "goal",
          "compact",
          "schedule",
          "browser",
          "plan",
          "grill-me",
          "teamwork",
          "learn",
          "boost",
        ].map((name) => ({ name, description: name, kind: "command" })),
        ...["agy-customizations", "antigravity-guide", "diagnose"].map((name) => ({
          name,
          description: name,
          kind: "skill",
        })),
      ]);
  } finally {
    await connection.close();
  }
});

it.each([true, false])(
  "loads a saved stream-JSON session with ACP system prompt support %s",
  async (supportsSystemPrompt) => {
    const { directory, launch } = await launchAgent(`
      const { appendFileSync } = require("node:fs");
      const { createInterface } = require("node:readline");
      const configOptions = [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon",
          options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }, { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "gemini-4-neon-high", name: "Gemini 4 Neon High" }] },
        { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "low",
          options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "accept-edits",
          options: [{ value: "default", name: "Default" }, { value: "accept-edits", name: "Accept edits" }] },
      ];
      const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
      createInterface({ input: process.stdin }).on("line", (line) => {
        appendFileSync(process.env.CAPTURE, line + "\\n");
        const { id, method, params } = JSON.parse(line);
        switch (method) {
          case "initialize":
            send({ id, result: { protocolVersion: 1, agentCapabilities: {
              loadSession: true,
              _meta: { antigravity: { systemPrompt: { append: ${supportsSystemPrompt} } } },
            } } });
            break;
          case "session/load":
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Saved reply" },
            } } });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call", toolCallId: "write", name: "write_file", title: "File notes.txt",
              status: "completed", kind: "edit", rawInput: { Path: "/repo/notes.txt", Content: "hello" },
            } } });
            send({ id, result: { configOptions } });
            break;
          case "session/set_config_option":
            configOptions.find(option => option.id === params.configId).currentValue = params.value;
            send({ id, result: { configOptions } });
            break;
          case "session/close":
            send({ id, result: {} });
            break;
        }
      });
    `);
    const provider = createAntigravityProvider();
    expect(await provider.status!({ launch })).toMatchObject({ available: true });
    const connection = await provider.connect({
      launch,
      versions: [1],
      capabilities: ["session.configure", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "restore",
        sessionId: "test",
        history: "replay",
        persistence: { version: 1, data: { conversationId: "saved-conversation" } },
        config: {
          cwd: directory,
          model: "gemini-3.8-flash-high",
          mode: "full-access",
          systemPrompt: "A test system instruction",
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await expect
        .poll(
          () =>
            events.find(
              (event) => event.type === "session.ready" || event.type === "request.failed",
            ),
          { timeout: 3_000 },
        )
        .toMatchObject({ type: "session.ready" });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.opened",
          persistence: { version: 1, data: { sessionId: "saved-conversation" } },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({ type: "assistant_message", text: "Saved reply" }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.config",
          config: expect.objectContaining({
            mode: "full-access",
            modes: expect.arrayContaining([
              expect.objectContaining({ id: "full-access", isUnattended: true }),
            ]),
            model: "gemini-3.8-flash",
            thinkingOption: "high",
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({
            type: "tool_call",
            detail: { type: "write", filePath: "/repo/notes.txt", content: "hello" },
          }),
        }),
      );
      await connection.send({
        type: "session.configure",
        requestId: "native-model",
        sessionId: "test",
        changes: { model: "gemini-4-neon-high" },
      });
      await expect
        .poll(() =>
          events.find(
            (event) =>
              event.type === "session.config" && event.config.model === "gemini-4-neon-high",
          ),
        )
        .toBeDefined();
      const requests = (await readFile(launch.env.CAPTURE, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const load = requests.find((request) => request.method === "session/load");
      expect(load.params.sessionId).toBe("saved-conversation");
      expect(load.params._meta.antigravity).toEqual(
        supportsSystemPrompt
          ? { systemPrompt: { append: "A test system instruction" } }
          : undefined,
      );
    } finally {
      await connection.close();
    }
  },
);

const completedToolCalls = [
  {
    toolCallId: "shell",
    name: "run_command",
    kind: "execute",
    rawInput: {
      CommandLine: "printf test; exit 7",
      WaitMsBeforeAsync: 5000,
      toolSummary: "Run exit code test",
    },
    rawOutput: { output: "Command exited with code 7.\n\nCommand output:\ntest", exit_code: 7 },
  },
  {
    toolCallId: "read",
    name: "read_file",
    kind: "read",
    locations: [{ path: "/repo/probe.txt" }],
    rawInput: { Path: "/repo/probe.txt", StartLine: 2, EndLine: 2 },
  },
  {
    toolCallId: "write",
    name: "write_file",
    kind: "edit",
    locations: [{ path: "/repo/probe.txt" }],
    rawInput: { Path: "/repo/probe.txt", Content: "alpha\nbeta\ngamma\n", Overwrite: true },
    rawOutput: {},
    content: [{ type: "diff", path: "/repo/probe.txt", newText: "alpha\nbeta\ngamma\n" }],
  },
  {
    toolCallId: "edit",
    name: "edit_file",
    kind: "edit",
    locations: [{ path: "/repo/probe.txt" }],
    rawInput: { Path: "/repo/probe.txt", Target: "beta", Replacement: "delta" },
    rawOutput: {},
    content: [
      {
        type: "diff",
        path: "/repo/probe.txt",
        oldText: "alpha\nbeta\ngamma\n",
        newText: "alpha\ndelta\ngamma\n",
      },
    ],
  },
  {
    toolCallId: "web",
    name: "search_web",
    kind: "search",
    rawInput: { query: "IANA example domains" },
  },
  {
    toolCallId: "paseo",
    name: "mcp_paseo_send_agent_prompt",
    kind: "other",
    rawInput: { agentId: "agent-1", prompt: "Hello", toolSummary: "Send message" },
  },
  {
    toolCallId: "mcp",
    name: "mcp_local_tools_echo_message",
    kind: "other",
    rawInput: { message: "hello", toolSummary: "Echo message hello" },
  },
  {
    toolCallId: "ambiguous",
    name: "mcp_paseo_get_agent_status",
    kind: "other",
    rawInput: { agentId: "agent-1", toolSummary: "Get agent status" },
  },
];

it.each(["live", "replay"] as const)(
  "maps Antigravity tool calls in %s timelines",
  async (source) => {
    const { directory, launch } = await launchAgent(`
    const { createInterface } = require("node:readline");
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    const tools = ${JSON.stringify(completedToolCalls)};
    const modes = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] };
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      const update = (update) => send({ method: "session/update", params: { sessionId: params.sessionId ?? "agy-session", update } });
      switch (method) {
        case "initialize":
          send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          break;
        case "session/new":
          send({ id, result: { sessionId: "agy-session", modes } });
          update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          break;
        case "session/load":
        case "session/prompt":
          for (const { rawOutput, content, ...tool } of tools) {
            const completed = { status: "completed", rawOutput, content };
            if (method === "session/load") {
              update({ sessionUpdate: "tool_call", title: tool.name, ...tool, ...completed });
            } else {
              update({ sessionUpdate: "tool_call", title: tool.name, ...tool, status: "in_progress" });
              update({ sessionUpdate: "tool_call_update", toolCallId: tool.toolCallId, ...completed });
            }
          }
          send({ id, result: method === "session/load" ? { modes } : { stopReason: "end_turn" } });
          break;
        case "session/close":
          send({ id, result: {} });
          break;
      }
    });
  `);
    const connection = await createAntigravityProvider().connect({
      launch,
      versions: [1],
      capabilities: ["session.persistence", "prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "open",
        sessionId: "test",
        history: source === "replay" ? "replay" : "skip",
        persistence:
          source === "replay" ? { version: 1, data: { sessionId: "agy-session" } } : undefined,
        config: {
          cwd: directory,
          env: {},
          mcpServers: {
            paseo_get: { type: "stdio", command: "other-server" },
            local_tools: { type: "stdio", command: "echo-mcp" },
          },
          settings: {},
          persist: true,
        },
      });
      await expect
        .poll(
          () =>
            events.find(
              (event) => event.type === "session.ready" || event.type === "request.failed",
            ),
          { timeout: 4_000 },
        )
        .toMatchObject({ type: "session.ready" });
      if (source === "live") {
        await connection.send({
          type: "session.prompt",
          sessionId: "test",
          prompt: {
            clientMessageId: "exercise-tools",
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "Exercise tools" }] },
          },
        });
      }
      const calls = () =>
        events.flatMap((event) =>
          event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
        );
      await expect
        .poll(() => calls().filter((call) => call.status === "completed").length)
        .toBe(completedToolCalls.length);
      const completed = Object.fromEntries(calls().map((call) => [call.id, call]));
      expect(completed.shell.detail).toEqual({
        type: "shell",
        command: "printf test; exit 7",
        output: "Command exited with code 7.\n\nCommand output:\ntest",
        exitCode: 7,
      });
      expect(completed.read.detail).toEqual({
        type: "read",
        filePath: "/repo/probe.txt",
        offset: 2,
        limit: 1,
      });
      expect(completed.write.detail).toEqual({
        type: "write",
        filePath: "/repo/probe.txt",
        content: "alpha\nbeta\ngamma\n",
      });
      expect(completed.edit.detail).toEqual({
        type: "edit",
        filePath: "/repo/probe.txt",
        oldString: "alpha\nbeta\ngamma\n",
        newString: "alpha\ndelta\ngamma\n",
      });
      expect(completed.web.detail).toEqual({
        type: "search",
        toolName: "web_search",
        query: "IANA example domains",
      });
      expect(completed.paseo).toMatchObject({
        name: "paseo.send_agent_prompt",
        detail: { type: "unknown", input: { agentId: "agent-1", prompt: "Hello" }, output: null },
      });
      expect(completed.paseo.detail).not.toHaveProperty("input.toolSummary");
      expect(completed.mcp).toMatchObject({
        name: "local_tools.echo_message",
        detail: { type: "unknown", input: { message: "hello" }, output: null },
      });
      expect(completed.mcp.detail).not.toHaveProperty("input.toolSummary");
      expect(completed.ambiguous).toMatchObject({
        name: "mcp_paseo_get_agent_status",
        detail: { type: "unknown", input: { agentId: "agent-1" }, output: null },
      });
      if (source === "live") {
        expect(calls()).toContainEqual(
          expect.objectContaining({
            id: "shell",
            status: "running",
            detail: { type: "shell", command: "printf test; exit 7" },
          }),
        );
      }
    } finally {
      await connection.close();
    }
  },
);

// agy 1.5.14 lists `thought_level` only for the selected model and omits it for Orchestrator.
it("offers each model its own thinking options and opens Orchestrator with its default", async () => {
  const { directory, launch } = await launchAgent(`
    const { createInterface } = require("node:readline");
    const levels = (...values) => values.map((value) => ({ value, name: value }));
    const thinking = {
      "gemini-4-neon": { currentValue: "high", options: levels("low", "medium", "high", "xhigh") },
      "gemini-4-carbon": { currentValue: "high", options: levels("low", "medium", "high") },
      "claude-opus-5-5": { currentValue: "medium", options: levels("low", "medium", "high") },
    };
    let model = "gemini-4-neon";
    const configOptions = () => [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
        { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
        { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
      ] },
      ...(thinking[model] ? [{ id: "thought_level", name: "Thinking", category: "thought_level", type: "select", ...thinking[model] }] : []),
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
        options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
    ];
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      if (method === "initialize") send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
      if (method === "session/new") {
        model = "gemini-4-neon";
        send({ id, result: { sessionId: "native", configOptions: configOptions() } });
      }
      if (method === "session/set_config_option") {
        if (params.configId === "thought_level" && !thinking[model]) {
          send({ id, error: { code: -32602, message: "unknown config option" } });
          return;
        }
        if (params.configId === "model") model = params.value;
        else if (params.configId === "thought_level") thinking[model].currentValue = params.value;
        send({ id, result: { configOptions: configOptions() } });
      }
      if (method === "session/close") send({ id, result: {} });
    });
  `);
  const connection = await createAntigravityProvider().connect({
    launch,
    versions: [1],
    capabilities: ["session.configure"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({ type: "catalog", requestId: "catalog", cwd: directory });
    await expect
      .poll(() =>
        events.find((event) => event.type === "catalog" || event.type === "request.failed"),
      )
      .toMatchObject({ type: "catalog" });
    const catalog = events.find((event) => event.type === "catalog");
    if (catalog?.type !== "catalog") throw new Error("Expected a catalog");
    const thinkingByModel = Object.fromEntries(
      catalog.catalog.models.map((model) => [
        model.id,
        {
          options: model.thinkingOptions?.map((option) => option.id),
          default: model.defaultThinkingOptionId,
        },
      ]),
    );
    expect(thinkingByModel).toEqual({
      "gemini-4-neon": { options: ["low", "medium", "high", "xhigh"], default: "high" },
      "gemini-4-carbon": { options: ["low", "medium", "high"], default: "high" },
      "gemini-pro-orchestrator-neon": { options: [], default: undefined },
      "claude-opus-5-5": { options: ["low", "medium", "high"], default: "medium" },
    });

    await connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "orchestrator",
      history: "skip",
      config: {
        cwd: directory,
        model: "gemini-pro-orchestrator-neon",
        mode: "full-access",
        thinkingOption: thinkingByModel["gemini-pro-orchestrator-neon"]!.default,
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              (event.type === "session.ready" && event.sessionId === "orchestrator") ||
              (event.type === "request.failed" && event.requestId === "open"),
          ),
        { timeout: 3_000 },
      )
      .toMatchObject({ type: "session.ready" });
  } finally {
    await connection.close();
  }
});

describe("installation", () => {
  const signal = new AbortController().signal;

  it("reports the version agy prints and links its install docs", async () => {
    // A real `agy acp --version` starts the ACP server, so the fake refuses it.
    const { launch } = await launchAgent(`
      const args = process.argv.slice(2);
      if (args.includes("acp")) process.exit(1);
      if (args[0] === "--version") console.log("Antigravity CLI 1.6.2");
    `);
    const installation = createAntigravityProvider().installation!;
    expect(installation.installUrl).toBe("https://antigravity.google/docs/getting-started?tab=cli");
    expect(installation.update).toBeUndefined();
    await expect(
      installation.inspect!({ launch: { ...launch, resolved: true }, signal }),
    ).resolves.toEqual({
      status: "installed",
      version: "1.6.2",
    });
  });

  it("is not installed when the executable does not resolve", async () => {
    const launch = { command: "agy", args: ["acp"], env: {}, resolved: false };
    await expect(
      createAntigravityProvider().installation!.inspect!({ launch, signal }),
    ).resolves.toEqual({ status: "not_installed" });
  });
});

it("completes the turn when a recurring schedule stays in progress after end_turn", async () => {
  const { directory, launch } = await launchAgent(`
    const { createInterface } = require("node:readline");
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method } = JSON.parse(line);
      const update = (update) => send({ method: "session/update", params: { sessionId: "agy-session", update } });
      switch (method) {
        case "initialize":
          send({ id, result: { protocolVersion: 1 } });
          break;
        case "session/new":
          send({ id, result: { sessionId: "agy-session", modes: {
            currentModeId: "default", availableModes: [{ id: "default", name: "Default" }],
          } } });
          update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          break;
        case "session/prompt": {
          const args = { CronExpression: "*/15 * * * *", Prompt: "ping" };
          update({ sessionUpdate: "usage_update", used: 12725, size: 1048576 });
          update({
            sessionUpdate: "tool_call", toolCallId: "cron", name: "schedule",
            args, status: "in_progress", kind: "other", title: "Run schedule", rawInput: args,
          });
          update({ sessionUpdate: "usage_update", used: 12915, size: 1048576 });
          send({ id, result: { stopReason: "end_turn" } });
          break;
        }
        case "session/close":
          send({ id, result: {} });
          break;
      }
    });
  `);
  const connection = await createAntigravityProvider().connect({
    launch,
    versions: [1],
    capabilities: ["prompt.message"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "test",
      history: "skip",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
    });
    await expect
      .poll(() => events)
      .toContainEqual(expect.objectContaining({ type: "session.ready", sessionId: "test" }));
    await connection.send({
      type: "session.prompt",
      sessionId: "test",
      prompt: {
        clientMessageId: "schedule-turn",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "Schedule a recurring ping" }] },
      },
    });
    await expect
      .poll(() => events)
      .toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({ type: "tool_call", id: "cron", status: "running" }),
        }),
      );
    await expect
      .poll(() => events)
      .toContainEqual({
        type: "session.turn",
        sessionId: "test",
        turnId: "acp:schedule-turn",
        state: "completed",
      });
  } finally {
    await connection.close();
  }
});

it("keeps a turn open for backgrounded run_command calls but not IsDaemon commands", async () => {
  const { directory, launch } = await launchAgent(`
    const { createInterface } = require("node:readline");
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    let turn = 0;
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      switch (method) {
        case "initialize":
          send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
          break;
        case "session/new":
          send({ id, result: { sessionId: "agy-session", configOptions: [
            { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
              options: [{ value: "default", name: "Default" }] },
          ] } });
          break;
        case "session/prompt":
          turn += 1;
          if (turn === 1) {
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call", toolCallId: "daemon-1", name: "run_command",
              title: "Dev server", status: "in_progress", rawInput: { CommandLine: "npm run dev", IsDaemon: true },
            } } });
            send({ id, result: { stopReason: "end_turn" } });
          } else {
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call", toolCallId: "bg-1", name: "run_command",
              title: "Background build", status: "in_progress", rawInput: { CommandLine: "sleep 1" },
            } } });
            send({ id, result: { stopReason: "end_turn" } });
            setTimeout(() => {
              send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed",
              } } });
              send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Build finished." },
              } } });
              send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                sessionUpdate: "usage_update", used: 50, size: 1000,
              } } });
            }, 80);
          }
          break;
        case "session/close":
          send({ id, result: {} });
          break;
      }
    });
  `);
  const provider = createAntigravityProvider();
  const connection = await provider.connect({
    launch,
    versions: [1],
    capabilities: ["prompt.message"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "agy-test",
      history: "skip",
      config: {
        cwd: directory,
        env: {},
        mcpServers: {},
        settings: {},
        persist: false,
      },
    });
    await expect
      .poll(() => events.find((event) => event.type === "session.ready"), { timeout: 3_000 })
      .toBeDefined();

    // Turn 1: IsDaemon: true completes immediately on end_turn.
    await connection.send({
      type: "session.prompt",
      sessionId: "agy-test",
      prompt: {
        clientMessageId: "daemon-turn",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "start dev server" }] },
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "session.turn" &&
              event.turnId === "acp:daemon-turn" &&
              event.state === "completed",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();

    // Turn 2: non-daemon background command keeps turn open until completion + reply + usage_update.
    await connection.send({
      type: "session.prompt",
      sessionId: "agy-test",
      prompt: {
        clientMessageId: "bg-turn",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "run build" }] },
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "timeline.item" &&
              event.item.type === "tool_call" &&
              event.item.id === "bg-1" &&
              event.item.status === "running",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:bg-turn" &&
          event.state === "completed",
      ),
    ).toBe(false);
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "session.turn" &&
              event.turnId === "acp:bg-turn" &&
              event.state === "completed",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "Build finished." }),
      }),
    );
  } finally {
    await connection.close();
  }
});

it("completes turns when manage_task cancels a backgrounded run_command without tool_call_update", async () => {
  const brainRoot = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-brain-"));
  directories.push(brainRoot);
  const nativeSessionId = "410c02f3-7c64-45fb-acf0-52147aae36f9";
  const logsDir = path.join(brainRoot, nativeSessionId, ".system_generated", "logs");
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, "transcript_full.jsonl");

  const { directory, launch } = await launchAgent(`
    const { appendFileSync } = require("node:fs");
    const { createInterface } = require("node:readline");
    const transcript = process.env.TRANSCRIPT_PATH;
    const sessionId = ${JSON.stringify(nativeSessionId)};
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    const writeLog = (entry) => appendFileSync(transcript, JSON.stringify(entry) + "\\n");
    let turn = 0;
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      switch (method) {
        case "initialize":
          send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
          break;
        case "session/new":
          send({ id, result: { sessionId, configOptions: [
            { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
              options: [{ value: "default", name: "Default" }] },
          ] } });
          break;
        case "session/prompt":
          turn += 1;
          if (turn === 1) {
            // Same-turn kill: run_command backgrounded then canceled before end_turn, no tool_call_update.
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call", toolCallId: sessionId + ":1", kind: "execute",
              title: "sleep 30", status: "in_progress", rawInput: { command_line: "sleep 30" },
            } } });
            writeLog({
              step_index: 1, type: "RUN_COMMAND", status: "RUNNING",
              content: [
                "Created At: 2026-11-23T08:47:32-08:00",
                "Tool is running as a background task with task id: " + sessionId + "/task-1",
                "Task Description: sleep 30",
                "Task logs are available at: file:///tmp/task-1.log",
              ].join("\\n"),
            });
            writeLog({
              step_index: 2, type: "GENERIC", status: "DONE",
              content: [
                "Created At: 2026-11-23T08:47:33-08:00",
                "Completed At: 2026-11-23T08:47:33-08:00",
                'Task "' + sessionId + '/task-1" cancelled.',
              ].join("\\n"),
            });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Killed it." },
            } } });
            send({ id, result: { stopReason: "end_turn" } });
          } else {
            // Deferred-turn kill: stays open across end_turn, then canceled on wakeup with no tool_call_update.
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call", toolCallId: sessionId + ":2", kind: "execute",
              title: "sleep 60", status: "in_progress", rawInput: { command_line: "sleep 60" },
            } } });
            writeLog({
              step_index: 3, type: "RUN_COMMAND", status: "RUNNING",
              content: [
                "Created At: 2026-11-23T08:48:00-08:00",
                "Tool is running as a background task with task id: " + sessionId + "/task-2",
                "Task Description: sleep 60",
                "Task logs are available at: file:///tmp/task-2.log",
              ].join("\\n"),
            });
            send({ id, result: { stopReason: "end_turn" } });
            setTimeout(() => {
              writeLog({
                step_index: 4, type: "GENERIC", status: "DONE",
                content: [
                  "Created At: 2026-11-23T08:48:01-08:00",
                  "Completed At: 2026-11-23T08:48:01-08:00",
                  'Task "' + sessionId + '/task-2" cancelled.',
                ].join("\\n"),
              });
              send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Canceled after wakeup." },
              } } });
              send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                sessionUpdate: "usage_update", used: 60, size: 1000,
              } } });
            }, 80);
          }
          break;
        case "session/close":
          send({ id, result: {} });
          break;
      }
    });
  `);
  const provider = createAntigravityProvider({ brainRoots: [brainRoot], reconcileIntervalMs: 30 });
  const connection = await provider.connect({
    launch: { ...launch, env: { ...launch.env, TRANSCRIPT_PATH: transcriptPath } },
    versions: [1],
    capabilities: ["prompt.message"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "agy-kill-test",
      history: "skip",
      config: {
        cwd: directory,
        env: {},
        mcpServers: {},
        settings: {},
        persist: false,
      },
    });
    await expect
      .poll(() => events.find((event) => event.type === "session.ready"), { timeout: 3_000 })
      .toBeDefined();

    // Turn 1: same-turn kill completes immediately on end_turn and terminalizes the tool call.
    await connection.send({
      type: "session.prompt",
      sessionId: "agy-kill-test",
      prompt: {
        clientMessageId: "same-turn-kill",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "start and kill" }] },
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "session.turn" &&
              event.turnId === "acp:same-turn-kill" &&
              event.state === "completed",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          id: `${nativeSessionId}:1`,
          status: "canceled",
        }),
      }),
    );

    // Turn 2: deferred-turn kill settles once transcript records cancellation + reply + usage_update.
    await connection.send({
      type: "session.prompt",
      sessionId: "agy-kill-test",
      prompt: {
        clientMessageId: "deferred-kill",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "start then cancel later" }] },
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "timeline.item" &&
              event.item.type === "tool_call" &&
              event.item.id === `${nativeSessionId}:2` &&
              event.item.status === "running",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:deferred-kill" &&
          event.state === "completed",
      ),
    ).toBe(false);
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "session.turn" &&
              event.turnId === "acp:deferred-kill" &&
              event.state === "completed",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          id: `${nativeSessionId}:2`,
          status: "canceled",
        }),
      }),
    );
  } finally {
    await connection.close();
  }
});

it("settles a deferred turn when cancellation flushes to transcript after the final usage_update", async () => {
  const brainRoot = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-late-flush-"));
  directories.push(brainRoot);
  const nativeSessionId = "510c02f3-7c64-45fb-acf0-52147aae36f9";
  const logsDir = path.join(brainRoot, nativeSessionId, ".system_generated", "logs");
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, "transcript_full.jsonl");

  const { directory, launch } = await launchAgent(`
    const { appendFileSync } = require("node:fs");
    const { createInterface } = require("node:readline");
    const transcript = process.env.TRANSCRIPT_PATH;
    const sessionId = ${JSON.stringify(nativeSessionId)};
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    const writeLog = (entry) => appendFileSync(transcript, JSON.stringify(entry) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      switch (method) {
        case "initialize":
          send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
          break;
        case "session/new":
          send({ id, result: { sessionId, configOptions: [
            { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
              options: [{ value: "default", name: "Default" }] },
          ] } });
          break;
        case "session/prompt":
          send({ method: "session/update", params: { sessionId: params.sessionId, update: {
            sessionUpdate: "tool_call", toolCallId: "late-flush-call", kind: "execute",
            title: "sleep 30", status: "in_progress", rawInput: { command_line: "sleep 30" },
          } } });
          writeLog({
            step_index: 1, type: "RUN_COMMAND", status: "RUNNING",
            content: [
              "Created At: 2026-11-23T08:47:32-08:00",
              "Tool is running as a background task with task id: " + sessionId + "/task-1",
              "Task Description: sleep 30",
              "Task logs are available at: file:///tmp/task-1.log",
            ].join("\\n"),
          });
          send({ id, result: { stopReason: "end_turn" } });
          // Emit final reply + usage_update FIRST, then flush transcript cancellation 120ms later with NO further ACP events.
          setTimeout(() => {
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Canceled it." },
            } } });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "usage_update", used: 60, size: 1000,
            } } });
          }, 40);
          setTimeout(() => {
            writeLog({
              step_index: 2, type: "GENERIC", status: "DONE",
              content: [
                "Created At: 2026-11-23T08:47:33-08:00",
                "Completed At: 2026-11-23T08:47:33-08:00",
                'Task "' + sessionId + '/task-1" cancelled.',
              ].join("\\n"),
            });
          }, 160);
          break;
        case "session/close":
          send({ id, result: {} });
          break;
      }
    });
  `);
  const provider = createAntigravityProvider({ brainRoots: [brainRoot], reconcileIntervalMs: 30 });
  const connection = await provider.connect({
    launch: { ...launch, env: { ...launch.env, TRANSCRIPT_PATH: transcriptPath } },
    versions: [1],
    capabilities: ["prompt.message"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open",
      requestId: "open-late",
      sessionId: "agy-late-flush",
      history: "skip",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
    });
    await expect
      .poll(() => events.find((event) => event.type === "session.ready"), { timeout: 3_000 })
      .toBeDefined();

    await connection.send({
      type: "session.prompt",
      sessionId: "agy-late-flush",
      prompt: {
        clientMessageId: "late-flush-turn",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "start and kill" }] },
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "session.turn" &&
              event.turnId === "acp:late-flush-turn" &&
              event.state === "completed",
          ),
        { timeout: 4_000 },
      )
      .toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          id: "late-flush-call",
          status: "canceled",
        }),
      }),
    );
  } finally {
    await connection.close();
  }
});

it("handles parallel identical commands where one is killed and one completes normally on wire", async () => {
  const brainRoot = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-parallel-"));
  directories.push(brainRoot);
  const nativeSessionId = "610c02f3-7c64-45fb-acf0-52147aae36f9";
  const logsDir = path.join(brainRoot, nativeSessionId, ".system_generated", "logs");
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, "transcript_full.jsonl");

  const { directory, launch } = await launchAgent(`
    const { appendFileSync } = require("node:fs");
    const { createInterface } = require("node:readline");
    const transcript = process.env.TRANSCRIPT_PATH;
    const sessionId = ${JSON.stringify(nativeSessionId)};
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    const writeLog = (entry) => appendFileSync(transcript, JSON.stringify(entry) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      switch (method) {
        case "initialize":
          send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
          break;
        case "session/new":
          send({ id, result: { sessionId, configOptions: [
            { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
              options: [{ value: "default", name: "Default" }] },
          ] } });
          break;
        case "session/prompt":
          send({ method: "session/update", params: { sessionId: params.sessionId, update: {
            sessionUpdate: "tool_call", toolCallId: "parallel-a", kind: "execute",
            title: "sleep 30", status: "in_progress", rawInput: { command_line: "sleep 30" },
          } } });
          send({ method: "session/update", params: { sessionId: params.sessionId, update: {
            sessionUpdate: "tool_call", toolCallId: "parallel-b", kind: "execute",
            title: "sleep 30", status: "in_progress", rawInput: { command_line: "sleep 30" },
          } } });
          writeLog({
            step_index: 1, type: "RUN_COMMAND", status: "RUNNING",
            content: [
              "Created At: 2026-11-23T08:47:32-08:00",
              "Tool is running as a background task with task id: " + sessionId + "/task-1",
              "Task Description: sleep 30",
              "Task logs are available at: file:///tmp/task-1.log",
            ].join("\\n"),
          });
          writeLog({
            step_index: 2, type: "RUN_COMMAND", status: "RUNNING",
            content: [
              "Created At: 2026-11-23T08:47:32-08:00",
              "Tool is running as a background task with task id: " + sessionId + "/task-2",
              "Task Description: sleep 30",
              "Task logs are available at: file:///tmp/task-2.log",
            ].join("\\n"),
          });
          // Kill A before end_turn while B stays running.
          writeLog({
            step_index: 3, type: "GENERIC", status: "DONE",
            content: [
              "Created At: 2026-11-23T08:47:33-08:00",
              "Completed At: 2026-11-23T08:47:33-08:00",
              'Task "' + sessionId + '/task-1" cancelled.',
            ].join("\\n"),
          });
          send({ id, result: { stopReason: "end_turn" } });
          // B finishes normally on wire AND in transcript, then agent emits reply + usage_update.
          setTimeout(() => {
            writeLog({
              step_index: 4, type: "SYSTEM_MESSAGE", status: "DONE",
              content: [
                "The following is a <SYSTEM_MESSAGE>",
                '[Message] timestamp=2026-11-23T16:49:02Z sender=' + sessionId + '/task-2 priority=MESSAGE_PRIORITY_LOW content=Task id "' + sessionId + '/task-2" finished with result:',
                "Step ended.",
              ].join("\\n"),
            });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call_update", toolCallId: "parallel-b", status: "completed",
            } } });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B finished and A was killed." },
            } } });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "usage_update", used: 90, size: 1000,
            } } });
          }, 80);
          break;
        case "session/close":
          send({ id, result: {} });
          break;
      }
    });
  `);
  const provider = createAntigravityProvider({ brainRoots: [brainRoot], reconcileIntervalMs: 30 });
  const connection = await provider.connect({
    launch: { ...launch, env: { ...launch.env, TRANSCRIPT_PATH: transcriptPath } },
    versions: [1],
    capabilities: ["prompt.message"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open",
      requestId: "open-parallel",
      sessionId: "agy-parallel",
      history: "skip",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
    });
    await expect
      .poll(() => events.find((event) => event.type === "session.ready"), { timeout: 3_000 })
      .toBeDefined();

    await connection.send({
      type: "session.prompt",
      sessionId: "agy-parallel",
      prompt: {
        clientMessageId: "parallel-turn",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "run two sleeps" }] },
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "session.turn" &&
              event.turnId === "acp:parallel-turn" &&
              event.state === "completed",
          ),
        { timeout: 4_000 },
      )
      .toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          id: "parallel-a",
          status: "canceled",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          id: "parallel-b",
          status: "completed",
        }),
      }),
    );
  } finally {
    await connection.close();
  }
});

it("does not let pre-existing historical cancellations on session open cancel a fresh run of the same command", async () => {
  const brainRoot = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-baseline-"));
  directories.push(brainRoot);
  const nativeSessionId = "710c02f3-7c64-45fb-acf0-52147aae36f9";
  const logsDir = path.join(brainRoot, nativeSessionId, ".system_generated", "logs");
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, "transcript_full.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 1,
        type: "RUN_COMMAND",
        status: "RUNNING",
        content: [
          "Created At: 2026-11-23T08:00:00-08:00",
          `Tool is running as a background task with task id: ${nativeSessionId}/task-1`,
          "Task Description: sleep 30",
          "Task logs are available at: file:///tmp/task-1.log",
        ].join("\n"),
      }),
      JSON.stringify({
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        content: [
          "Created At: 2026-11-23T08:00:05-08:00",
          "Completed At: 2026-11-23T08:00:05-08:00",
          `Task "${nativeSessionId}/task-1" cancelled.`,
        ].join("\n"),
      }),
    ].join("\n") + "\n",
  );

  const { directory, launch } = await launchAgent(`
    const { createInterface } = require("node:readline");
    const sessionId = ${JSON.stringify(nativeSessionId)};
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      switch (method) {
        case "initialize":
          send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
          break;
        case "session/new":
          send({ id, result: { sessionId, configOptions: [
            { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
              options: [{ value: "default", name: "Default" }] },
          ] } });
          break;
        case "session/prompt":
          // Start a fresh sleep 30 before any new RUN_COMMAND row has flushed to disk.
          send({ method: "session/update", params: { sessionId: params.sessionId, update: {
            sessionUpdate: "tool_call", toolCallId: "fresh-sleep", kind: "execute",
            title: "sleep 30", status: "in_progress", rawInput: { command_line: "sleep 30" },
          } } });
          send({ id, result: { stopReason: "end_turn" } });
          setTimeout(() => {
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call_update", toolCallId: "fresh-sleep", status: "completed",
            } } });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fresh run finished." },
            } } });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "usage_update", used: 75, size: 1000,
            } } });
          }, 150);
          break;
        case "session/close":
          send({ id, result: {} });
          break;
      }
    });
  `);
  const provider = createAntigravityProvider({ brainRoots: [brainRoot], reconcileIntervalMs: 30 });
  const connection = await provider.connect({
    launch,
    versions: [1],
    capabilities: ["prompt.message"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open",
      requestId: "open-baseline",
      sessionId: "agy-baseline",
      history: "skip",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
    });
    await expect
      .poll(() => events.find((event) => event.type === "session.ready"), { timeout: 3_000 })
      .toBeDefined();

    await connection.send({
      type: "session.prompt",
      sessionId: "agy-baseline",
      prompt: {
        clientMessageId: "fresh-turn",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "run fresh sleep" }] },
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "timeline.item" &&
              event.item.type === "tool_call" &&
              event.item.id === "fresh-sleep" &&
              event.item.status === "running",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();
    // Wait briefly and confirm the turn stays deferred rather than prematurely canceling fresh-sleep.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:fresh-turn" &&
          event.state === "completed",
      ),
    ).toBe(false);

    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "session.turn" &&
              event.turnId === "acp:fresh-turn" &&
              event.state === "completed",
          ),
        { timeout: 4_000 },
      )
      .toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          id: "fresh-sleep",
          status: "completed",
        }),
      }),
    );
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "fresh-sleep" &&
          event.item.status === "canceled",
      ),
    ).toBe(false);
  } finally {
    await connection.close();
  }
});
