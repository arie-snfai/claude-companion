import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from "child_process";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
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

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
// Guards the pace-ratio division right at window start, where a tiny elapsed
// time would otherwise blow the ratio up towards infinity.
const MIN_ELAPSED_MS = 60_000;

const COLOR_GREEN = "#4CAF50";
const COLOR_ORANGE = "#FF9800";
const COLOR_RED = "#F44336";

interface RateLimitWindow {
  utilization: number | null;
  resets_at: string | null;
}

interface UsageResponse {
  rate_limits_available: boolean;
  rate_limits: {
    five_hour: RateLimitWindow;
    seven_day: RateLimitWindow;
  } | null;
  subscription_type: string | null;
}

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
// waiting on; `lastPingedResetIso` is the boundary we already acted on, so a
// poll that still reports the old (now past) reset time can't re-fire.
let resetTimer: ReturnType<typeof setTimeout> | undefined;
let scheduledResetIso: string | undefined;
let lastPingedResetIso: string | undefined;
let pingChild: ChildProcess | undefined;

export function activate(context: vscode.ExtensionContext): void {
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
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("claudeCompanion.autoStartSession")) return;
      // Re-arm (or tear down) against the current reset time immediately
      // rather than waiting up to 5 minutes for the next poll.
      clearResetTimer();
      if (isAutoStartEnabled()) {
        scheduleSessionPing(lastGoodUsage?.rate_limits?.five_hour.resets_at ?? null);
      }
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
  pingChild?.kill();
  pingChild = undefined;
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

function clearResetTimer(): void {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = undefined;
  scheduledResetIso = undefined;
}

/**
 * Arms a one-shot timer for the moment the current 5h window expires. Called
 * on every successful poll: if the reset time is unchanged the existing timer
 * stands, and once a boundary has been pinged it is never pinged again (the
 * API keeps reporting the old `resets_at` for a while after expiry).
 */
function scheduleSessionPing(resetsAt: string | null): void {
  if (!isAutoStartEnabled() || !resetsAt) return;
  if (resetsAt === lastPingedResetIso) return;
  if (resetsAt === scheduledResetIso && resetTimer) return;

  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) return;

  clearResetTimer();
  scheduledResetIso = resetsAt;
  const delay = Math.max(resetDate.getTime() - Date.now() + PING_GRACE_MS, 0);
  resetTimer = setTimeout(() => {
    resetTimer = undefined;
    scheduledResetIso = undefined;
    lastPingedResetIso = resetsAt;
    void startNewSession({ auto: true }).then(() => updateStatusBar());
  }, delay);
}

/**
 * Opens a fresh 5h window by running one trivial `claude -p` turn. Runs from
 * the temp dir rather than a workspace folder so no project CLAUDE.md or repo
 * context is pulled into a throwaway prompt.
 */
function startNewSession(opts: { auto: boolean }): Promise<void> {
  if (opts.auto && !isAutoStartEnabled()) return Promise.resolve();
  if (pingChild) return Promise.resolve();

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(findClaudeBinary(), ["-p", getPingPrompt(), "--max-turns", "1"], {
        cwd: os.tmpdir(),
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      reportPingFailure(opts, err instanceof Error ? err.message : String(err));
      resolve();
      return;
    }

    pingChild = child;
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
      if (pingChild === child) pingChild = undefined;
      if (message) {
        reportPingFailure(opts, message);
      } else if (!opts.auto) {
        vscode.window.setStatusBarMessage("$(check) Claude: new session started", 5_000);
      }
      resolve();
    };

    timeout = setTimeout(() => {
      child.kill();
      finish("Timed out waiting for Claude Code CLI");
    }, PING_TIMEOUT_MS);

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

function reportPingFailure(opts: { auto: boolean }, message: string): void {
  const prefix = opts.auto ? "Could not auto-start a new Claude session" : "Could not start a new Claude session";
  void vscode.window.showWarningMessage(`${prefix}: ${message}`);
}

async function updateStatusBar(): Promise<void> {
  try {
    const usage = await usageChannel.request();
    const fiveHour = usage.rate_limits?.five_hour;
    const sevenDay = usage.rate_limits?.seven_day;

    if (usage.rate_limits_available && fiveHour && sevenDay) {
      lastGoodUsage = usage;
      staleStreak = 0;
      renderUsage(usage);
      scheduleSessionPing(fiveHour.resets_at);
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

/**
 * The bundled CLI version ships with the VS Code extension and is known to
 * support the `get_usage` control request; a separately-installed `claude`
 * on PATH may be older and lack it, so prefer the bundled one when present.
 */
function findClaudeBinary(): string {
  const ext = vscode.extensions.getExtension("anthropic.claude-code");
  if (ext) {
    const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
    const bundledPath = path.join(ext.extensionPath, "resources", "native-binary", binaryName);
    if (fs.existsSync(bundledPath)) {
      return bundledPath;
    }
  }
  return "claude";
}

interface PendingRequest {
  resolve: (usage: UsageResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Keeps a single long-lived `claude` control-protocol process for the life of
 * the extension, instead of spawning a fresh one per poll. Spawning a new
 * process every minute was confirmed (via the VS Code extension host log) to
 * trip a bug in the real Claude Code extension's own channel-cleanup code
 * every time our process exited — one persistent process avoids that churn.
 */
class UsageChannel {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();

  request(): Promise<UsageResponse> {
    const child = this.ensureChild();
    const id = String(this.nextId++);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timed out waiting for Claude Code CLI"));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: id,
          request: { subtype: "get_usage" },
        }) + "\n",
        (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new Error(`Failed to write to Claude Code CLI: ${err.message}`));
          }
        },
      );
    });
  }

  dispose(): void {
    this.failAllPending(new Error("Extension deactivated"));
    this.child?.kill();
    this.child = undefined;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child;
    }

    const binaryPath = findClaudeBinary();
    const child = spawn(
      binaryPath,
      ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.on("error", (err) => {
      this.failAllPending(new Error(`Failed to launch Claude Code CLI: ${err.message}`));
    });
    child.on("close", () => {
      this.failAllPending(new Error("Claude Code CLI process exited"));
      if (this.child === child) {
        this.child = undefined;
      }
    });

    this.child = child;
    this.buffer = "";
    return child;
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.type !== "control_response") return;

    const response = msg.response;
    const id = response?.request_id;
    if (!id || !this.pending.has(id)) return;

    const pending = this.pending.get(id)!;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (response.subtype === "error") {
      pending.reject(new Error(response.error ?? "Unknown control request error"));
      return;
    }
    if (response.subtype === "success" && response.response) {
      pending.resolve(response.response as UsageResponse);
      return;
    }
    pending.reject(new Error("Unrecognized control response shape"));
  }

  private failAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

const usageChannel = new UsageChannel();
