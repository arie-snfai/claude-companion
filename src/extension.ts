import * as vscode from "vscode";
import * as os from "os";
import { spawn, ChildProcess } from "child_process";

import { findClaudeBinary } from "./claudeBinary";
import { findInterruptedSession, InterruptedSession } from "./interruptedSession";
import { RateLimitWindow, UsageChannel, UsageResponse } from "./usageChannel";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const BAR_WIDTH = 10;
// Consecutive polls with no usable data before we stop showing stale numbers
// and fall back to the warning state (3 polls * 5 min interval = 15 min).
const MAX_STALE_POLLS = 3;

// Small cushion after the reported reset timestamp before we ping — firing on
// the exact boundary risks the server still counting the request against the
// window that just closed.
const PING_GRACE_MS = 5_000;
// A one-shot `claude -p` turn is normally a few seconds; anything past this is
// a hung process, not a slow answer.
const PING_TIMEOUT_MS = 120_000;
// A resumed turn does real work, so it gets far longer than a ping. This is a
// backstop against a wedged process, not an expected duration.
const RESUME_TIMEOUT_MS = 60 * 60_000;
// Resuming into an almost-spent window would just hit the limit again a few
// tool calls later, so wait for a window with room in it.
const RESUME_MAX_UTILIZATION = 90;
// Interruptions already acted on, so one limit hit is never resumed twice.
// Capped because it only exists to suppress repeats, not as history.
const HANDLED_RESUMES_KEY = "claudeCompanion.handledResumes";
const MAX_HANDLED_RESUMES = 20;
const MAX_TITLE_LENGTH = 80;

// Undocumented command of the Claude Code extension, taking
// (sessionId, initialPrompt, viewColumn). It resumes that session in a chat
// panel and puts the prompt in the input box. Like `get_usage`, it is internal
// and could change; a missing command is reported rather than worked around.
const CLAUDE_OPEN_SESSION_COMMAND = "claude-vscode.editor.open";

const DEFAULT_RESUME_PROMPT =
  "Your previous turn was cut off partway through because the 5-hour session limit was reached. " +
  "Re-read the end of this conversation and continue that work from exactly where it stopped. " +
  "Do not start anything new.";

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
// Guards the pace-ratio division right at window start, where a tiny elapsed
// time would otherwise blow the ratio up towards infinity.
const MIN_ELAPSED_MS = 60_000;

const COLOR_GREEN = "#4CAF50";
const COLOR_ORANGE = "#FF9800";
const COLOR_RED = "#F44336";

// One item per metric. VS Code status bar items only support a single
// foreground color for their whole text (no way to color a substring), so
// splitting into an icon-item + bar-item to isolate the color looked like
// two disjointed clickable pieces. Coloring the whole pill reads as one
// cohesive unit instead.
let sessionItem: vscode.StatusBarItem;
let weeklyItem: vscode.StatusBarItem;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

let lastGoodUsage: UsageResponse | undefined;
let staleStreak = 0;

// Auto-restart state. `scheduledResetIso` is the boundary the armed timer is
// waiting on; `lastHandledResetIso` is the boundary we already acted on, so a
// poll that still reports the old (now past) reset time can't re-fire.
let resetTimer: ReturnType<typeof setTimeout> | undefined;
let scheduledResetIso: string | undefined;
let lastHandledResetIso: string | undefined;
let activeChild: ChildProcess | undefined;

// Work that the 5h limit cut off and that is waiting for a fresh window, kept
// here so the status bar tooltip can say so before the resume fires.
let pendingResume: InterruptedSession | undefined;
// Set synchronously around a resume attempt. The reset timer and the poll can
// both decide to resume at nearly the same moment, and the scan between that
// decision and the launch is asynchronous, so without this they could each
// launch the same session.
let resumeInFlight = false;
let globalState: vscode.Memento | undefined;

export function activate(context: vscode.ExtensionContext): void {
  globalState = context.globalState;
  sessionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1_000_000);
  weeklyItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1_000_001);

  const allItems = [sessionItem, weeklyItem];
  for (const item of allItems) {
    item.command = "claudeCompanion.refresh";
    item.show();
  }

  context.subscriptions.push(...allItems);
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeCompanion.refresh", () => void updateStatusBar()),
    vscode.commands.registerCommand(
      "claudeCompanion.startNewSession",
      () => void startNewSession({ auto: false }),
    ),
    vscode.commands.registerCommand(
      "claudeCompanion.resumeInterruptedSession",
      () => void resumeInterruptedManually(),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration("claudeCompanion.autoStartSession") &&
        !event.affectsConfiguration("claudeCompanion.autoResume")
      ) {
        return;
      }
      // Re-arm (or tear down) against the current reset time immediately
      // rather than waiting up to 5 minutes for the next poll.
      clearResetTimer();
      scheduleResetAction(lastGoodUsage?.rate_limits?.five_hour.resets_at ?? null);
    }),
  );
  context.subscriptions.push({ dispose: () => usageChannel.dispose() });

  void updateStatusBar();
  refreshTimer = setInterval(() => void updateStatusBar(), REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });
  context.subscriptions.push({ dispose: () => clearResetTimer() });
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  clearResetTimer();
  activeChild?.kill();
  activeChild = undefined;
  usageChannel.dispose();
}

function isAutoStartEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("claudeCompanion")
    .get<boolean>("autoStartSession.enabled", true);
}

function getPingPrompt(): string {
  const configured = vscode.workspace
    .getConfiguration("claudeCompanion")
    .get<string>("autoStartSession.prompt", "hi");
  return configured.trim() || "hi";
}

function isAutoResumeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("claudeCompanion")
    .get<boolean>("autoResume.enabled", true);
}

function getResumePrompt(): string {
  const configured = vscode.workspace
    .getConfiguration("claudeCompanion")
    .get<string>("autoResume.prompt", DEFAULT_RESUME_PROMPT);
  return configured.trim() || DEFAULT_RESUME_PROMPT;
}

function isHeadlessResume(): boolean {
  return (
    vscode.workspace.getConfiguration("claudeCompanion").get<string>("autoResume.mode", "panel") ===
    "headless"
  );
}

function getResumePermissionMode(): string {
  return vscode.workspace
    .getConfiguration("claudeCompanion")
    .get<string>("autoResume.permissionMode", "default");
}

/** Folders this window owns. Sessions elsewhere belong to another window. */
function getWorkspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
}

function clearResetTimer(): void {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = undefined;
  scheduledResetIso = undefined;
}

/**
 * Arms a one-shot timer for the moment the current 5h window expires. Called
 * on every successful poll: if the reset time is unchanged the existing timer
 * stands, and once a boundary has been acted on it is never acted on again (the
 * API keeps reporting the old `resets_at` for a while after expiry).
 */
function scheduleResetAction(resetsAt: string | null): void {
  if (!isAutoStartEnabled() && !isAutoResumeEnabled()) return;
  if (!resetsAt) return;
  if (resetsAt === lastHandledResetIso) return;
  if (resetsAt === scheduledResetIso && resetTimer) return;

  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) return;

  clearResetTimer();
  scheduledResetIso = resetsAt;
  const delay = Math.max(resetDate.getTime() - Date.now() + PING_GRACE_MS, 0);
  resetTimer = setTimeout(() => {
    resetTimer = undefined;
    scheduledResetIso = undefined;
    lastHandledResetIso = resetsAt;
    void onWindowReset().then(() => updateStatusBar());
  }, delay);
}

/**
 * Continuing interrupted work opens the new window by itself, so the trivial
 * ping is only needed when there is nothing to resume.
 */
async function onWindowReset(): Promise<void> {
  // "busy" also means something is already opening the window, so the ping is
  // only needed when there was nothing to resume at all.
  if ((await tryResumeInterrupted({ auto: true })) !== "none") return;
  await startNewSession({ auto: true });
}

/**
 * Opens a fresh 5h window by running one trivial `claude -p` turn. Runs from
 * the temp dir rather than a workspace folder so no project CLAUDE.md or repo
 * context is pulled into a throwaway prompt.
 */
function startNewSession(opts: { auto: boolean }): Promise<void> {
  if (opts.auto && !isAutoStartEnabled()) return Promise.resolve();

  return runClaude({
    args: ["-p", getPingPrompt(), "--max-turns", "1"],
    cwd: os.tmpdir(),
    timeoutMs: PING_TIMEOUT_MS,
    failurePrefix: opts.auto
      ? "Could not auto-start a new Claude session"
      : "Could not start a new Claude session",
    successMessage: opts.auto ? undefined : "$(check) Claude: new session started",
  }).then(() => undefined);
}

interface RunOptions {
  args: string[];
  cwd: string;
  timeoutMs: number;
  failurePrefix: string;
  /** Shown briefly in the status bar on a clean exit; omit to stay silent. */
  successMessage?: string;
}

/**
 * Runs one `claude` process to completion, reporting failures as warnings. Only
 * one runs at a time: a ping and a resume both open a window, so overlapping
 * them would burn quota twice for one boundary.
 */
function runClaude(opts: RunOptions): Promise<boolean> {
  if (activeChild) return Promise.resolve(false);

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(findClaudeBinary(), opts.args, {
        cwd: opts.cwd,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      void vscode.window.showWarningMessage(
        `${opts.failurePrefix}: ${err instanceof Error ? err.message : String(err)}`,
      );
      resolve(false);
      return;
    }

    activeChild = child;
    let stderr = "";
    let settled = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (message?: string): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (activeChild === child) activeChild = undefined;
      if (message) {
        void vscode.window.showWarningMessage(`${opts.failurePrefix}: ${message}`);
      } else if (opts.successMessage) {
        vscode.window.setStatusBarMessage(opts.successMessage, 5_000);
      }
      resolve(!message);
    };

    timeout = setTimeout(() => {
      child.kill();
      finish("Timed out waiting for Claude Code CLI");
    }, opts.timeoutMs);

    child.on("error", (err: Error) => finish(`Failed to launch Claude Code CLI: ${err.message}`));
    child.on("close", (code: number | null) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim().split("\n").pop();
      finish(`claude exited with code ${code}${detail ? `: ${detail}` : ""}`);
    });
  });
}

type ResumeOutcome = "launched" | "none" | "busy";

/**
 * Picks up work that the 5h limit cut off, in the session it was cut off in, so
 * Claude reads its own history and carries on instead of starting over.
 *
 * The interruption is marked handled before the launch, not after, so a failed
 * resume is not retried in a loop. A *later* interruption of the same session
 * is a different key, so long work can span several windows.
 */
async function tryResumeInterrupted(opts: { auto: boolean }): Promise<ResumeOutcome> {
  if (opts.auto && !isAutoResumeEnabled()) return "none";
  // A ping or an earlier resume is still running; it owns this window.
  if (activeChild || resumeInFlight) return "busy";

  resumeInFlight = true;
  try {
    // Re-scan rather than trusting `pendingResume`: the user may have picked the
    // work back up by hand since it was detected.
    const session = await findInterruptedSession(getWorkspaceRoots());
    if (!session) return "none";
    // Manual invocation is explicit intent, so it ignores the handled list.
    if (opts.auto && isResumeHandled(session)) return "none";

    await markResumeHandled(session);
    pendingResume = undefined;
    launchResume(session);
    return "launched";
  } finally {
    resumeInFlight = false;
  }
}

function launchResume(session: InterruptedSession): void {
  const label = formatTitle(session.title) ?? session.sessionId.slice(0, 8);

  if (isHeadlessResume()) {
    launchHeadlessResume(session, label);
    return;
  }

  void reopenInClaudePanel(session, label).catch((err: unknown) => {
    void vscode.window.showWarningMessage(
      `Could not resume the interrupted Claude session: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/**
 * Hands the session back to the Claude Code extension, which resumes it in a
 * chat panel with the continue prompt staged in the input box. The extension
 * stages rather than sends it (its webview calls `setInputText`), so the last
 * keypress stays the user's.
 *
 * If that session already has a panel open, the extension reveals it and says
 * the prompt was not applied. There is no API for pushing a prompt into a live
 * panel, so that case ends with the work in front of you and nothing typed.
 */
async function reopenInClaudePanel(session: InterruptedSession, label: string): Promise<void> {
  const available = await vscode.commands.getCommands(true);
  if (!available.includes(CLAUDE_OPEN_SESSION_COMMAND)) {
    void vscode.window.showWarningMessage(
      `Could not resume ${label} in Claude Code: this version of the Claude Code extension has no ` +
        `${CLAUDE_OPEN_SESSION_COMMAND} command. Update it, or set ` +
        `claudeCompanion.autoResume.mode to "headless".`,
    );
    return;
  }

  // (sessionId, prompt); the third argument is a ViewColumn, left out so the
  // extension reuses whichever column already holds Claude panels.
  await vscode.commands.executeCommand(
    CLAUDE_OPEN_SESSION_COMMAND,
    session.sessionId,
    getResumePrompt(),
  );
  void vscode.window.showInformationMessage(
    `Reopened the session the limit interrupted (${label}). The continue prompt is waiting in its input box.`,
  );
}

function launchHeadlessResume(session: InterruptedSession, label: string): void {
  void vscode.window.showInformationMessage(`Claude is resuming interrupted work: ${label}`);
  // Not awaited: the caller only launches the resume, it does not wait out
  // however long the work takes.
  void runClaude({
    args: buildResumeArgs(session),
    cwd: session.cwd,
    timeoutMs: RESUME_TIMEOUT_MS,
    failurePrefix: "Could not resume the interrupted Claude session",
    successMessage: "$(check) Claude: resumed session finished",
  });
}

function buildResumeArgs(session: InterruptedSession): string[] {
  const args = ["--resume", session.sessionId];
  const permissionMode = getResumePermissionMode();
  if (permissionMode !== "default") {
    args.push("--permission-mode", permissionMode);
  }
  args.push("-p", getResumePrompt());
  return args;
}

async function resumeInterruptedManually(): Promise<void> {
  const outcome = await tryResumeInterrupted({ auto: false });
  if (outcome === "launched") return;

  if (outcome === "busy") {
    void vscode.window.showWarningMessage("A Claude session is already being started. Try again shortly.");
    return;
  }
  void vscode.window.showInformationMessage(
    "No session in this workspace was interrupted by the 5h limit.",
  );
}

/** Identifies one interruption, so re-running into the limit gets its own turn. */
function resumeKey(session: InterruptedSession): string {
  return `${session.sessionId}@${session.interruptedAt}`;
}

function isResumeHandled(session: InterruptedSession): boolean {
  return readHandledResumes().includes(resumeKey(session));
}

function readHandledResumes(): string[] {
  return globalState?.get<string[]>(HANDLED_RESUMES_KEY, []) ?? [];
}

async function markResumeHandled(session: InterruptedSession): Promise<void> {
  const handled = [...readHandledResumes(), resumeKey(session)];
  await globalState?.update(HANDLED_RESUMES_KEY, handled.slice(-MAX_HANDLED_RESUMES));
}

/**
 * Detects work waiting on a fresh window, and says whether it can go now. A
 * limit hit inside the *current* window has to wait for the reset timer; one
 * from an earlier window means the new window is already open.
 */
async function refreshPendingResume(fiveHour: RateLimitWindow): Promise<boolean> {
  if (!isAutoResumeEnabled()) {
    pendingResume = undefined;
    return false;
  }

  const session = await findInterruptedSession(getWorkspaceRoots());
  pendingResume = session && !isResumeHandled(session) ? session : undefined;
  if (!pendingResume) return false;

  return (
    clampPercent(fiveHour.utilization) < RESUME_MAX_UTILIZATION &&
    isNewWindow(pendingResume.interruptedAt, fiveHour.resets_at)
  );
}

/** True when the interruption predates the window that is live right now. */
function isNewWindow(interruptedAt: string, resetsAt: string | null): boolean {
  const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  // No live window to speak of: whatever runs next opens one.
  if (Number.isNaN(resetMs) || resetMs <= Date.now()) return true;

  const interruptedMs = Date.parse(interruptedAt);
  if (Number.isNaN(interruptedMs)) return false;
  return interruptedMs < resetMs - FIVE_HOUR_MS;
}

async function updateStatusBar(): Promise<void> {
  try {
    const usage = await usageChannel.request();
    const fiveHour = usage.rate_limits?.five_hour;
    const sevenDay = usage.rate_limits?.seven_day;

    if (usage.rate_limits_available && fiveHour && sevenDay) {
      lastGoodUsage = usage;
      staleStreak = 0;
      const resumeNow = await refreshPendingResume(fiveHour);
      renderUsage(usage);
      scheduleResetAction(fiveHour.resets_at);
      // The window the work was waiting for is already open, most often
      // because VS Code was closed when the reset went by.
      if (resumeNow) void tryResumeInterrupted({ auto: true });
      return;
    }

    // The CLI answered but hasn't populated rate limits yet (known flaky
    // behavior of this undocumented endpoint) — keep showing the last good
    // reading rather than flashing an error on every hollow response.
    staleStreak++;
    if (lastGoodUsage && staleStreak <= MAX_STALE_POLLS) {
      renderUsage(lastGoodUsage, { stale: true });
    } else {
      renderError("Rate limit data unavailable");
    }
  } catch (err) {
    staleStreak++;
    if (lastGoodUsage && staleStreak <= MAX_STALE_POLLS) {
      renderUsage(lastGoodUsage, { stale: true });
    } else {
      renderError(err instanceof Error ? err.message : String(err));
    }
  }
}

function renderUsage(usage: UsageResponse, opts: { stale?: boolean } = {}): void {
  const fiveHour = usage.rate_limits?.five_hour;
  const sevenDay = usage.rate_limits?.seven_day;
  if (!fiveHour || !sevenDay) {
    renderError("Rate limit data unavailable");
    return;
  }

  const staleNote = opts.stale ? "\n\n_(showing last known reading — live data temporarily unavailable)_" : "";

  const sessionPct = clampPercent(fiveHour.utilization);
  const sessionRatio = computePaceRatio(sessionPct, fiveHour.resets_at, FIVE_HOUR_MS);
  sessionItem.text = `$(clock) ${renderBar(sessionPct)} ${sessionPct}%${opts.stale ? "*" : ""}`;
  sessionItem.color = paceColor(sessionPct, sessionRatio);
  sessionItem.backgroundColor = undefined;
  sessionItem.tooltip = new vscode.MarkdownString(
    `**Claude session usage (5h window)**\n\n${sessionPct}% used\n\nResets ${formatResetLine(fiveHour.resets_at)}` +
      formatPaceLine(sessionRatio) +
      formatPendingResumeLine() +
      staleNote,
  );

  const weeklyPct = clampPercent(sevenDay.utilization);
  const weeklyRatio = computePaceRatio(weeklyPct, sevenDay.resets_at, SEVEN_DAY_MS);
  weeklyItem.text = `$(calendar) ${renderBar(weeklyPct)} ${weeklyPct}%${opts.stale ? "*" : ""}`;
  weeklyItem.color = paceColor(weeklyPct, weeklyRatio);
  weeklyItem.backgroundColor = undefined;
  weeklyItem.tooltip = new vscode.MarkdownString(
    `**Claude weekly usage (7d window)**\n\n${weeklyPct}% used\n\nResets ${formatResetLine(sevenDay.resets_at)}` +
      formatPaceLine(weeklyRatio) +
      (usage.subscription_type ? `\n\nPlan: ${usage.subscription_type}` : "") +
      staleNote,
  );
}

/**
 * Fraction of quota used divided by fraction of the window elapsed. 1.0
 * means "on track to land at exactly 100% right at reset." Above 1.0 means
 * burning faster than sustainable (will hit the limit before reset); below
 * 1.0 means comfortably under pace — e.g. 60% used with 20 minutes left in a
 * 5h window is fine (ratio ≈ 0.64), but 20% used in the first 20 minutes of
 * that same window is not (ratio ≈ 3.0).
 */
function computePaceRatio(usagePct: number, resetsAt: string | null, windowDurationMs: number): number | null {
  if (!resetsAt) return null;
  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) return null;

  const remainingMs = resetDate.getTime() - Date.now();
  const elapsedMs = Math.max(windowDurationMs - remainingMs, MIN_ELAPSED_MS);
  const elapsedFraction = Math.min(elapsedMs / windowDurationMs, 1);

  return usagePct / 100 / elapsedFraction;
}

/** Colorize by burn rate rather than raw percentage — see computePaceRatio. */
function paceColor(usagePct: number, paceRatio: number | null): string {
  if (usagePct >= 95) return COLOR_RED;
  if (usagePct <= 3) return COLOR_GREEN;

  if (paceRatio === null) {
    // No reset time to compare against — fall back to flat percentage bands.
    if (usagePct >= 80) return COLOR_RED;
    if (usagePct >= 50) return COLOR_ORANGE;
    return COLOR_GREEN;
  }

  if (paceRatio >= 1.3) return COLOR_RED;
  if (paceRatio >= 0.8) return COLOR_ORANGE;
  return COLOR_GREEN;
}

function formatPaceLine(paceRatio: number | null): string {
  if (paceRatio === null) return "";
  return `\n\nBurn rate: ${paceRatio.toFixed(1)}x sustainable pace`;
}

function formatPendingResumeLine(): string {
  if (!pendingResume) return "";
  const when = new Date(pendingResume.interruptedAt);
  const at = Number.isNaN(when.getTime()) ? "" : ` at ${when.toLocaleTimeString()}`;
  const title = formatTitle(pendingResume.title);
  return (
    `\n\n**Interrupted work waiting${at}**` +
    (title ? `: ${title}` : "") +
    "\n\nIt will be reopened in Claude Code as soon as a window with room in it is open."
  );
}

/** Keeps a session title to one short line so tooltips stay readable. */
function formatTitle(title: string | undefined): string | undefined {
  const collapsed = title?.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > MAX_TITLE_LENGTH
    ? `${collapsed.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : collapsed;
}

function renderError(message: string): void {
  const warningBg = new vscode.ThemeColor("statusBarItem.warningBackground");
  sessionItem.text = "$(warning) Claude usage";
  sessionItem.tooltip = `Could not fetch Claude usage: ${message}\n\nClick to retry.`;
  sessionItem.backgroundColor = warningBg;
  sessionItem.color = undefined;
  weeklyItem.text = "";
  weeklyItem.tooltip = undefined;
  weeklyItem.backgroundColor = undefined;
  weeklyItem.color = undefined;
}

function clampPercent(value: number | null): number {
  if (value === null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function renderBar(percent: number, width: number = BAR_WIDTH): string {
  const filled = Math.round((percent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatResetLine(resetsAt: string | null): string {
  if (!resetsAt) return "unknown";
  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) return "unknown";

  const diffMs = resetDate.getTime() - Date.now();
  if (diffMs <= 0) return "now";

  const totalMinutes = Math.round(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  let relative: string;
  if (days > 0) {
    relative = `in ${days}d ${hours}h`;
  } else if (hours > 0) {
    relative = `in ${hours}h ${minutes}m`;
  } else {
    relative = `in ${minutes}m`;
  }

  return `${relative} (${resetDate.toLocaleString()})`;
}


// One long-lived control-protocol process for the life of the extension; see
// UsageChannel for why it is not spawned per poll.
const usageChannel = new UsageChannel();
