import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { findInterruptedSession, isInsideRoots } from "./interruptedSession";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

let sandbox: string;
let transcriptRoot: string;
/** Stands in for a workspace folder; sessions elsewhere must be ignored. */
let workspace: string;

before(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "claude-companion-test-"));
  transcriptRoot = path.join(sandbox, "projects");
  workspace = path.join(sandbox, "workspace");
  await fs.mkdir(workspace, { recursive: true });
});

after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

interface WriteOptions {
  sessionId: string;
  entries: unknown[];
  /** Transcript mtime, which is what the recency cut filters on. */
  mtimeMs?: number;
  /** Sub-path under the project dir, for the subagents/ case. */
  subdir?: string;
  project?: string;
}

async function writeTranscript(opts: WriteOptions): Promise<string> {
  const dir = path.join(transcriptRoot, opts.project ?? "-workspace", opts.subdir ?? "");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${opts.sessionId}.jsonl`);
  await fs.writeFile(
    file,
    opts.entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n"),
  );
  const mtime = new Date(opts.mtimeMs ?? NOW - HOUR_MS);
  await fs.utimes(file, mtime, mtime);
  return file;
}

function limitError(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-08-12T09:00:00.000Z",
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: "You've hit your session limit · resets 2:00pm (Asia/Jerusalem)" }],
    },
    error: "rate_limit",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    cwd: workspace,
    sessionId: "session-a",
    ...overrides,
  };
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: "2026-08-12T09:30:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
    cwd: workspace,
    sessionId: "session-a",
  };
}

function scan(roots: readonly string[] = [workspace]) {
  return findInterruptedSession(roots, { now: NOW, transcriptRoot });
}

async function reset(): Promise<void> {
  await fs.rm(transcriptRoot, { recursive: true, force: true });
}

test("finds a session whose transcript ends at the limit error", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-a",
    entries: [
      assistantMessage("working on it"),
      limitError(),
      // Bookkeeping records are written after the limit error and must not
      // count as the work having continued.
      { type: "ai-title", aiTitle: "Wire up the payer report", sessionId: "session-a" },
      { type: "last-prompt", lastPrompt: "add the date range filter", sessionId: "session-a" },
    ],
  });

  const found = await scan();

  assert.equal(found?.sessionId, "session-a");
  assert.equal(found?.cwd, workspace);
  assert.equal(found?.interruptedAt, "2026-08-12T09:00:00.000Z");
  assert.equal(found?.title, "Wire up the payer report");
});

test("falls back to the last prompt when no title was generated", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-a",
    entries: [limitError(), { type: "last-prompt", lastPrompt: "add the date range filter" }],
  });

  assert.equal((await scan())?.title, "add the date range filter");
});

test("ignores a session that was already picked back up", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-a",
    entries: [limitError(), assistantMessage("picked the work back up")],
  });

  assert.equal(await scan(), undefined);
});

test("treats a transient API error after the limit as noise, not as work", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-a",
    entries: [
      limitError(),
      {
        type: "assistant",
        timestamp: "2026-08-12T09:05:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "API Error: 529 Overloaded" }] },
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        cwd: workspace,
        sessionId: "session-a",
      },
    ],
  });

  assert.equal((await scan())?.sessionId, "session-a");
});

test("does not treat a non-rate-limit error as an interruption", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-a",
    entries: [
      assistantMessage("working on it"),
      {
        type: "assistant",
        timestamp: "2026-08-12T09:05:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "API Error: 529 Overloaded" }] },
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        cwd: workspace,
        sessionId: "session-a",
      },
    ],
  });

  assert.equal(await scan(), undefined);
});

test("ignores sessions that ran outside the given roots", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-elsewhere",
    project: "-other",
    entries: [limitError({ cwd: path.join(sandbox, "other-project"), sessionId: "session-elsewhere" })],
  });

  assert.equal(await scan(), undefined);
});

test("accepts a session that ran in a subdirectory of a root", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-nested",
    entries: [limitError({ cwd: path.join(workspace, "packages", "api"), sessionId: "session-nested" })],
  });

  assert.equal((await scan())?.sessionId, "session-nested");
});

test("returns the most recent interruption when several qualify", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-old",
    entries: [limitError({ sessionId: "session-old", timestamp: "2026-08-12T06:00:00.000Z" })],
    mtimeMs: NOW - 5 * HOUR_MS,
  });
  await writeTranscript({
    sessionId: "session-new",
    entries: [limitError({ sessionId: "session-new", timestamp: "2026-08-12T10:00:00.000Z" })],
  });

  assert.equal((await scan())?.sessionId, "session-new");
});

test("ignores transcripts last touched more than 12h ago", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-stale",
    entries: [limitError({ sessionId: "session-stale" })],
    mtimeMs: NOW - 13 * HOUR_MS,
  });

  assert.equal(await scan(), undefined);
});

test("ignores subagent transcripts, which cannot be resumed on their own", async () => {
  await reset();
  await writeTranscript({
    sessionId: "agent-abc123",
    subdir: path.join("session-a", "subagents"),
    entries: [limitError({ isSidechain: true, sessionId: "session-a" })],
  });

  assert.equal(await scan(), undefined);
});

test("skips an interruption with no recorded cwd, which cannot be resumed", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-a",
    entries: [limitError({ cwd: undefined })],
  });

  assert.equal(await scan(), undefined);
});

test("skips an interruption with no timestamp, which cannot be placed in a window", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-a",
    entries: [limitError({ timestamp: undefined })],
  });

  assert.equal(await scan(), undefined);
});

test("falls back to the filename when the entry carries no session id", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-from-filename",
    entries: [limitError({ sessionId: undefined })],
  });

  assert.equal((await scan())?.sessionId, "session-from-filename");
});

test("survives a half-written trailing line", async () => {
  await reset();
  await writeTranscript({
    sessionId: "session-a",
    entries: [limitError(), '{"type":"last-prompt","lastPro'],
  });

  assert.equal((await scan())?.sessionId, "session-a");
});

test("survives an empty transcript", async () => {
  await reset();
  await writeTranscript({ sessionId: "session-empty", entries: [] });

  assert.equal(await scan(), undefined);
});

test("returns nothing when the window has no folder open", async () => {
  await reset();
  await writeTranscript({ sessionId: "session-a", entries: [limitError()] });

  assert.equal(await scan([]), undefined);
});

test("returns nothing when there is no transcript history at all", async () => {
  await reset();

  assert.equal(await scan(), undefined);
});

test("isInsideRoots matches the root itself and nested paths only", () => {
  const root = path.join(path.sep, "home", "dev", "project");

  assert.equal(isInsideRoots(root, [root]), true);
  assert.equal(isInsideRoots(path.join(root, "src", "api"), [root]), true);
  assert.equal(isInsideRoots(path.dirname(root), [root]), false);
  assert.equal(isInsideRoots(`${root}-other`, [root]), false);
  assert.equal(isInsideRoots(root, []), false);
  assert.equal(isInsideRoots(root, [path.join(path.sep, "tmp"), root]), true);
});
