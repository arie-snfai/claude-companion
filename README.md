# Claude Companion

A standalone VS Code extension that shows your Claude Code **session (5h)** and
**weekly (7d)** usage as progress bars in the status bar, color-coded by burn
rate rather than raw percentage - and optionally opens a fresh session for you
the moment the 5h window resets, picking up work the limit cut off mid-task.

![status bar example](https://img.shields.io/badge/status-experimental-orange)

## Why burn rate, not raw percentage

60% used with 20 minutes left in the session window is fine — the window is
about to reset anyway. 20% used in the first 20 minutes of that same window
is not fine — you're burning 3x the sustainable pace and will hit the limit
long before reset. The color is based on:

```
pace ratio = (fraction of quota used) / (fraction of window elapsed)
```

- **green** — under 0.8x sustainable pace
- **orange** — 0.8x–1.3x
- **red** — 1.3x+, or usage ≥ 95% regardless of pace

Hover either item for the exact numbers and the reset time.

## Auto-start a new session at reset

When the 5h session window expires, the extension fires one trivial `claude -p`
turn so a fresh window opens immediately instead of waiting for you to send the
first message. Run it manually any time with **"Claude Companion: Start New Session
Now"** from the command palette.

| Setting | Default | Meaning |
|---|---|---|
| `claudeCompanion.autoStartSession.enabled` | `true` | Fire the ping at every 5h reset |
| `claudeCompanion.autoStartSession.prompt` | `"hi"` | What gets sent |

Two things to know before leaving it on:

- Each ping is a real turn and costs a small amount of your **weekly** quota.
- The ping **anchors** the new window. Ping at 07:40 and sit down at 08:00, and
  that window expires at 12:40, not 13:00. Over a day your reset boundaries
  drift to wherever the pings landed. That is the point of the feature - there
  is always a live window - but set `enabled` to `false` if you would rather
  your windows line up with when you actually start working.

The ping runs from the OS temp dir, so no workspace `CLAUDE.md` or repo context
is pulled into it.

## Continue work the limit cut off

When Claude runs out of 5h quota mid-task it stops where it stands and writes
`You've hit your session limit · resets 6:10am` into the session transcript. The
extension notices that, and once a fresh window is open it re-launches **that
same session** with a "carry on from where you stopped" prompt, so Claude reads
its own history instead of starting over.

It fires in two situations:

- The armed reset timer goes off while VS Code is open. The resume takes the
  place of the trivial ping for that reset, so only one turn is spent.
- VS Code was closed when the reset went by. On the next poll the extension sees
  interrupted work plus a window that has since rolled over, and resumes then.

A session qualifies only while **all** of these hold, which is what keeps it from
resurrecting work you have moved on from:

- The limit error is still the last thing in the transcript. Anything after it,
  from you or from an earlier resume, means the work was already picked back up.
- The transcript was last written within the past 12 hours.
- The session's working directory is inside a folder open in **this** window.
  That is also what stops two VS Code windows from both resuming one session.
- The current 5h window is under 90% used, so the resume is not walking straight
  back into the limit.

One limit hit is resumed once. If the resumed session runs into the limit again,
that is a new interruption and gets picked up at the next reset, so long work can
cross several windows. Run it by hand any time with **"Claude Companion: Resume
Interrupted Session Now"**, which ignores the once-only rule.

| Setting | Default | Meaning |
|---|---|---|
| `claudeCompanion.autoResume.enabled` | `true` | Resume interrupted work at reset |
| `claudeCompanion.autoResume.mode` | `"terminal"` | `terminal` opens the resumed session in a VS Code terminal; `headless` runs it in the background via `claude -p` |
| `claudeCompanion.autoResume.prompt` | (see settings) | What the resumed session is told |
| `claudeCompanion.autoResume.permissionMode` | `"default"` | `--permission-mode` for the resumed session |

`terminal` mode is the default because you can see what Claude is doing and
answer its permission prompts. `headless` mode keeps working while you are away
from the machine, but nothing can answer a prompt for it: raise
`permissionMode` to `acceptEdits` or higher, or the resume will stall on the
first tool call that needs approval. `bypassPermissions` means unattended edits
and shell commands, so choose it deliberately.

Either way the 5h tooltip tells you what is waiting before anything runs.

## How it works

This reads usage data via an **undocumented, internal control-protocol
request** (`get_usage`) sent to the `claude` CLI binary bundled inside the
official [Anthropic Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code)
VS Code extension. It reuses your existing Claude Code login — no separate
auth, no API key required.

**This is explicitly marked `EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`
in Anthropic's own source.** It could change or disappear in a future Claude
Code release with no warning. When that happens, this extension will show a
warning icon instead of breaking outright — but there's no guarantee the
underlying data source keeps working at all.

Interrupted-work detection reads a second undocumented surface: the session
transcripts under `~/.claude/projects/*/*.jsonl`, looking for the synthetic
`rate_limit` entry Claude Code writes when quota runs out. That format is
internal too. If it changes, the extension stops finding interrupted sessions
and falls back to the plain reset ping rather than misfiring.

## Requirements

- The [Anthropic Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code)
  extension must be installed and logged in.

## Install

Grab the `.vsix` from [Releases](https://github.com/arie-snfai/claude-companion/releases)
(or build it yourself, see below), then:

- VS Code UI: Extensions view → `...` menu → **"Install from VSIX..."**
- CLI: `code --install-extension claude-companion-*.vsix`

Reload the window afterwards.

## Build from source

```bash
npm install
npm run compile
npm test                  # transcript-scanning tests, via the node:test runner
npx @vscode/vsce package
code --install-extension claude-companion-*.vsix
```

## License

MIT
