import { promises as fs } from "fs";
import type { Dirent } from "fs";
import type { FileHandle } from "fs/promises";
import * as os from "os";
import * as path from "path";

/**
 * A session whose last act was running out of 5h quota. Claude Code records
 * this as a synthetic assistant message in the transcript
 * (`"You've hit your session limit · resets 6:10am"`) tagged
 * `isApiErrorMessage: true`, `error: "rate_limit"`, `apiErrorStatus: 429`, and
 * then stops mid-task.
 */
export interface InterruptedSession {
  sessionId: string;
  /** Directory the session ran in; a resume has to run from the same place. */
  cwd: string;
  /** ISO timestamp of the limit error that ended the session. */
  interruptedAt: string;
  /** Human-readable label for notifications, from the transcript when present. */
  title?: string;
  transcriptPath: string;
}

const DEFAULT_TRANSCRIPT_ROOT = path.join(os.homedir(), ".claude", "projects");

// Older transcripts are not "work that just got cut off": the user has moved
// on since, and silently resuming day-old work would be a surprise.
const MAX_TRANSCRIPT_AGE_MS = 12 * 60 * 60 * 1000;
// Bounds the scan on machines with hundreds of sessions. Newest first, so the
// cut only ever drops transcripts that already lost the recency race.
const MAX_TRANSCRIPTS_SCANNED = 40;
// The limit error is by definition the last thing written to a cut-off
// transcript, so the tail is all that has to be parsed.
const TAIL_BYTES = 256 * 1024;

/** Only the fields this module reads; transcript entries carry many more. */
interface TranscriptEntry {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  error?: string;
  apiErrorStatus?: number;
  isApiErrorMessage?: boolean;
  aiTitle?: string;
  lastPrompt?: string;
}

export interface ScanOptions {
  /** Reference time for the recency cut. Defaults to now. */
  now?: number;
  /** Root of the per-project transcript directories. Defaults to the real one. */
  transcriptRoot?: string;
}

/**
 * Finds the most recently interrupted session whose working directory sits
 * inside one of `roots`. Scoping to the caller's workspace folders is what
 * keeps two VS Code windows from both trying to resume the same session.
 */
export async function findInterruptedSession(
  roots: readonly string[],
  options: ScanOptions = {},
): Promise<InterruptedSession | undefined> {
  if (roots.length === 0) return undefined;
  const now = options.now ?? Date.now();
  const transcriptRoot = options.transcriptRoot ?? DEFAULT_TRANSCRIPT_ROOT;

  let best: InterruptedSession | undefined;
  for (const transcript of await listRecentTranscripts(transcriptRoot, now)) {
    const session = await readInterruptedSession(transcript);
    if (!session || !isInsideRoots(session.cwd, roots)) continue;
    if (!best || Date.parse(session.interruptedAt) > Date.parse(best.interruptedAt)) {
      best = session;
    }
  }
  return best;
}

/** True when `cwd` is one of `roots` or nested under one of them. */
export function isInsideRoots(cwd: string, roots: readonly string[]): boolean {
  const target = normalizeForCompare(cwd);
  return roots.some((root) => {
    const rel = path.relative(normalizeForCompare(root), target);
    if (rel === "") return true;
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

function normalizeForCompare(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function listRecentTranscripts(transcriptRoot: string, now: number): Promise<string[]> {
  let projectDirs: Dirent[];
  try {
    projectDirs = await fs.readdir(transcriptRoot, { withFileTypes: true });
  } catch {
    return []; // No Claude Code history on this machine yet.
  }

  const found: { file: string; mtimeMs: number }[] = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(transcriptRoot, dir.name);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      // Deliberately not recursive: the `subagents/` subdirectory holds
      // sidechain copies, and a subagent's limit error is also written to its
      // parent transcript, which is the one that can actually be resumed.
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = path.join(dirPath, entry.name);
      try {
        const { mtimeMs } = await fs.stat(file);
        if (now - mtimeMs <= MAX_TRANSCRIPT_AGE_MS) found.push({ file, mtimeMs });
      } catch {
        // Raced with a deletion; nothing to scan.
      }
    }
  }

  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_TRANSCRIPTS_SCANNED)
    .map((candidate) => candidate.file);
}

async function readInterruptedSession(file: string): Promise<InterruptedSession | undefined> {
  const entries = parseEntries(await readTailLines(file));
  const marker = findLimitMarker(entries);
  // Without a cwd there is nowhere to resume from, and without a timestamp
  // there is no way to tell which 5h window the interruption belongs to.
  if (!marker?.cwd || !marker.timestamp) return undefined;

  return {
    sessionId: marker.sessionId ?? path.basename(file, ".jsonl"),
    cwd: marker.cwd,
    interruptedAt: marker.timestamp,
    title: findTitle(entries),
    transcriptPath: file,
  };
}

/**
 * Returns the limit error only while it is still the last thing that happened
 * in the session. Any real message after it means the work was already picked
 * back up (by the user, or by an earlier auto-resume), so there is nothing
 * left to continue.
 */
function findLimitMarker(entries: TranscriptEntry[]): TranscriptEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isRateLimitError(entry)) return entry;
    // Other API errors (overloaded, connection refused) are noise rather than
    // work, so they neither prove nor disprove an interruption.
    if (entry.isApiErrorMessage) continue;
    if (entry.type === "user" || entry.type === "assistant") return undefined;
    // Anything else is bookkeeping: ai-title, mode, last-prompt, pr-link, ...
  }
  return undefined;
}

function isRateLimitError(entry: TranscriptEntry): boolean {
  if (entry.isApiErrorMessage !== true) return false;
  return entry.error === "rate_limit" || entry.apiErrorStatus === 429;
}

/**
 * Prefers the session's generated title, falling back to the last prompt the
 * user typed. Both are bookkeeping records, so either may be absent from the
 * slice of transcript that was read.
 */
function findTitle(entries: TranscriptEntry[]): string | undefined {
  const aiTitle = findLastValue(entries, (entry) =>
    entry.type === "ai-title" ? entry.aiTitle : undefined,
  );
  if (aiTitle) return aiTitle;
  return findLastValue(entries, (entry) =>
    entry.type === "last-prompt" ? entry.lastPrompt : undefined,
  );
}

function findLastValue(
  entries: TranscriptEntry[],
  pick: (entry: TranscriptEntry) => string | undefined,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const value = pick(entries[i]);
    if (value) return value;
  }
  return undefined;
}

async function readTailLines(file: string): Promise<string[]> {
  let handle: FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return [];
  }

  try {
    const { size } = await handle.stat();
    const start = Math.max(size - TAIL_BYTES, 0);
    const length = size - start;
    if (length <= 0) return [];

    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    // A mid-file offset lands inside a line; drop that fragment.
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseEntries(lines: string[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // A partially flushed line from a session that is still writing.
    }
  }
  return entries;
}
