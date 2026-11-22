import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import contribute from "../index.server.js";
import { buildAntigravitySystemPromptAppend } from "./instructions.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-rules-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, content: string): Promise<string> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

it("loads global rules first, then workspace instructions from git root to cwd", async () => {
  const config = await write("custom/config/GEMINI.md", "  global config  \n");
  const last = await write("custom/config/rules/20-last.md", "second rule");
  const first = await write("custom/config/rules/10-first.md", "first rule");
  const global = await write("custom/GEMINI.md", "global legacy");
  await write("custom/config/rules/ignored.txt", "ignored");
  await write("project/.git", "gitdir: worktree");
  const agents = await write("project/AGENTS.md", "root agents");
  const gemini = await write("project/GEMINI.md", "root gemini");
  const nested = await write("project/subdir/GEMINI.md", "nested");
  await symlink(agents, path.join(root, "project/subdir/AGENTS.md"));

  expect(
    await buildAntigravitySystemPromptAppend({
      cwd: path.join(root, "project/subdir"),
      env: { HOME: root, GEMINI_HOME: "~/custom" },
    }),
  ).toBe(
    [
      [config, "global config"],
      [first, "first rule"],
      [last, "second rule"],
      [global, "global legacy"],
      [agents, "root agents"],
      [gemini, "root gemini"],
      [nested, "nested"],
    ]
      .map(([file, content]) => `# Instructions from ${file}\n\n${content}`)
      .join("\n\n"),
  );
});

it("uses HOME and reads only cwd outside a git worktree", async () => {
  const global = await write(".gemini/GEMINI.md", "home rules");
  await write("parent/AGENTS.md", "ignored ancestor");
  const local = await write("parent/child/AGENTS.md", "local rules");
  expect(
    await buildAntigravitySystemPromptAppend({
      cwd: path.dirname(local),
      env: { HOME: root },
    }),
  ).toBe(
    `# Instructions from ${global}\n\nhome rules\n\n# Instructions from ${local}\n\nlocal rules`,
  );
});

it("caps the append at 128 KiB without splitting a UTF-8 character", async () => {
  const budget = 128 * 1024;
  await write("AGENTS.md", "👋".repeat(budget));
  const prompt = await buildAntigravitySystemPromptAppend({ cwd: root, env: { HOME: root } });
  expect(Buffer.byteLength(prompt!)).toBeLessThanOrEqual(budget);
  expect(Buffer.byteLength(prompt!)).toBeGreaterThan(budget - 4);
  expect(prompt).toMatch(/\n\.\.\.\[truncated\]$/);
  expect(prompt).not.toContain("\uFFFD");
});

it("omits an append when rule files are absent or empty", async () => {
  await write("AGENTS.md", "\n  ");
  await expect(
    buildAntigravitySystemPromptAppend({ cwd: root, env: { HOME: root } }),
  ).resolves.toBeUndefined();
});

it("appends to existing prompts only for interactive Antigravity opens", async () => {
  const file = await write("project/AGENTS.md", "workspace rule");
  await write("project/.git", "gitdir: worktree");
  const addHook = vi.fn();
  contribute({
    addHook,
    registerProvider: vi.fn(),
    registerUsageSource: vi.fn(),
  } as unknown as PluginServerContext);
  expect(addHook).toHaveBeenCalledExactlyOnceWith("agent.open.before", expect.any(Function));
  const hook = addHook.mock.calls[0]?.[1];
  const request: PluginSessionOpenRequest = {
    agentId: "agent",
    workspaceId: null,
    provider: "antigravity",
    cwd: path.dirname(file),
    reason: "resume",
    purpose: "interactive",
    title: null,
    background: false,
    labels: {},
    metadata: {},
    appendSystemPrompt: ["previous hook"],
    tools: [],
    env: { HOME: root },
    mcpServers: {},
  };
  expect(await hook({ request })).toEqual({
    ...request,
    appendSystemPrompt: ["previous hook", `# Instructions from ${file}\n\nworkspace rule`],
  });
  expect(await hook({ request: { ...request, purpose: "history" } })).toBeUndefined();
  expect(await hook({ request: { ...request, provider: "codex" } })).toBeUndefined();
});
