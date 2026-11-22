import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

interface AntigravityInstructionSource {
  path: string;
  content: string;
}

interface ResolveAntigravityInstructionsOptions {
  cwd: string;
  env?: Record<string, string>;
  maxBytes?: number;
}

const DEFAULT_MAX_SYSTEM_PROMPT_BYTES = 128 * 1024;
const WORKSPACE_INSTRUCTION_FILENAMES = ["AGENTS.md", "GEMINI.md"] as const;

function expandLeadingTilde(inputPath: string, homeDir: string): string {
  if (inputPath === "~") {
    return homeDir;
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(homeDir, inputPath.slice(2));
  }
  return inputPath;
}

function resolveGeminiHome(homeDir: string, env?: Record<string, string>): string {
  const configured = env?.GEMINI_HOME?.trim();
  if (configured) {
    return path.resolve(expandLeadingTilde(configured, homeDir));
  }
  return path.join(homeDir, ".gemini");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listGlobalInstructionCandidates(geminiHome: string): Promise<string[]> {
  const candidates: string[] = [path.join(geminiHome, "config", "GEMINI.md")];
  const rulesDir = path.join(geminiHome, "config", "rules");
  try {
    const entries = (await readdir(rulesDir))
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      candidates.push(path.join(rulesDir, entry));
    }
  } catch {
    // Missing or unreadable rules directory is normal.
  }
  candidates.push(path.join(geminiHome, "GEMINI.md"));
  return candidates;
}

async function listWorkspaceDirectories(cwd: string): Promise<string[]> {
  const resolvedCwd = path.resolve(cwd);
  const chain: string[] = [];
  let current = resolvedCwd;
  let foundGitRoot = false;

  for (;;) {
    chain.push(current);
    if (await pathExists(path.join(current, ".git"))) {
      foundGitRoot = true;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return foundGitRoot ? chain.toReversed() : [resolvedCwd];
}

async function listWorkspaceInstructionCandidates(cwd: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const dir of await listWorkspaceDirectories(cwd)) {
    for (const filename of WORKSPACE_INSTRUCTION_FILENAMES) {
      candidates.push(path.join(dir, filename));
    }
  }
  return candidates;
}

async function readUniqueInstructionFile(
  candidate: string,
  seenRealPaths: Set<string>,
): Promise<AntigravityInstructionSource | null> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) {
      return null;
    }
    const canonicalPath = await realpath(candidate);
    if (seenRealPaths.has(canonicalPath)) {
      return null;
    }
    const content = (await readFile(canonicalPath, "utf8")).trim();
    if (!content) {
      return null;
    }
    seenRealPaths.add(canonicalPath);
    return { path: candidate, content };
  } catch {
    return null;
  }
}

async function resolveAntigravityInstructionSources(
  options: ResolveAntigravityInstructionsOptions,
): Promise<AntigravityInstructionSource[]> {
  const homeDir = options.env?.HOME ?? homedir();
  const geminiHome = resolveGeminiHome(homeDir, options.env);
  const seenRealPaths = new Set<string>();
  const sources: AntigravityInstructionSource[] = [];
  const candidates = [
    ...(await listGlobalInstructionCandidates(geminiHome)),
    ...(await listWorkspaceInstructionCandidates(options.cwd)),
  ];

  for (const candidate of candidates) {
    const source = await readUniqueInstructionFile(candidate, seenRealPaths);
    if (source) {
      sources.push(source);
    }
  }

  return sources;
}

export async function buildAntigravitySystemPromptAppend(
  options: ResolveAntigravityInstructionsOptions,
): Promise<string | undefined> {
  const sources = await resolveAntigravityInstructionSources(options);
  if (sources.length === 0) {
    return undefined;
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SYSTEM_PROMPT_BYTES;
  const sections: string[] = [];
  let usedBytes = 0;

  for (const source of sources) {
    const section = `# Instructions from ${source.path}\n\n${source.content}`;
    const separatorBytes = sections.length > 0 ? 2 : 0;
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (usedBytes + separatorBytes + sectionBytes <= maxBytes) {
      sections.push(section);
      usedBytes += separatorBytes + sectionBytes;
      continue;
    }
    const suffix = "\n...[truncated]";
    const remaining = maxBytes - usedBytes - separatorBytes - Buffer.byteLength(suffix, "utf8");
    if (remaining > 0) {
      const clipped = new TextDecoder().decode(Buffer.from(section).subarray(0, remaining), {
        stream: true,
      });
      sections.push(`${clipped}${suffix}`);
    }
    break;
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
