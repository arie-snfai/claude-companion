import { spawn, ChildProcessWithoutNullStreams } from "child_process";

import { findClaudeBinary } from "./claudeBinary";

const REQUEST_TIMEOUT_MS = 8_000;

export interface RateLimitWindow {
  utilization: number | null;
  resets_at: string | null;
}

export interface UsageResponse {
  rate_limits_available: boolean;
  rate_limits: {
    five_hour: RateLimitWindow;
    seven_day: RateLimitWindow;
  } | null;
  subscription_type: string | null;
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
export class UsageChannel {
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

