# Claude Companion

A VS Code extension that puts your Claude Code **session (5h)** and **weekly
(7d)** usage in the status bar as progress bars, colored by burn rate rather than
raw percentage. It can also open a fresh session the moment the 5h window resets,
and pick up work that the limit cut off mid-task.

![status bar example](https://img.shields.io/badge/status-experimental-orange)

## Install

Requires the [Anthropic Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code)
extension, installed and logged in: that is where the bundled `claude` binary
comes from, and there is no usage data without it. Also VS Code 1.85+, plus
Node.js 18+ and `code` on your PATH to build (on macOS, add `code` via Command
Palette → **"Shell Command: Install 'code' command in PATH"**).

```bash
git clone https://github.com/arie-snfai/claude-companion.git
cd claude-companion
npm ci
npx @vscode/vsce package                              # writes claude-companion-<version>.vsix
code --install-extension claude-companion-0.1.0.vsix
```

Reload the window and the two status bar items appear.

**On a second machine, skip the clone.** The `.vsix` is self-contained and about
20 KB, so copy the one you already built and install it there. There is nothing
to download: `*.vsix` is gitignored, and no build is attached to a
[release](https://github.com/arie-snfai/claude-companion/releases) yet.

```bash
scp claude-companion-0.1.0.vsix other-laptop:~/
code --install-extension ~/claude-companion-0.1.0.vsix   # on that laptop
```

**On a machine you have used Claude on before,** note that
[auto-resume](#continue-work-the-limit-cut-off) is on by default: it will pick up
any session there that the limit cut off within the last 12 hours. Set
`claudeCompanion.autoResume.enabled` to `false` first if you would rather it did
not.

## Why burn rate, not raw percentage

60% used with 20 minutes left in the session window is fine, because the window
is about to reset anyway. 20% used in the first 20 minutes of that same window is
not fine: you are burning 3x the sustainable pace and will hit the limit long
before reset. So the color comes from

```
pace ratio = (fraction of quota used) / (fraction of window elapsed)
```

- **green**: under 0.8x sustainable pace
- **orange**: 0.8x to 1.3x
- **red**: 1.3x and up, or usage at 95% or more regardless of pace

Hover either item for the exact numbers and the reset time.

## Auto-start a new session at reset

When the 5h window expires, the extension fires one trivial `claude -p` turn so
a fresh window opens immediately instead of waiting for you to send the first
message. Run it by hand any time with **"Claude Companion: Start New Session
Now"**.

| Setting | Default | Meaning |
|---|---|---|
| `claudeCompanion.autoStartSession.enabled` | `true` | Fire the ping at every 5h reset |
| `claudeCompanion.autoStartSession.prompt` | `"hi"` | What gets sent |

Two things to know before leaving it on:

- Each ping is a real turn and costs a small amount of your **weekly** quota.
- The ping **anchors** the new window. Ping at 07:40, sit down at 08:00, and that
  window expires at 12:40 rather than 13:00. Over a day your reset boundaries
  drift to wherever the pings landed. That is the point of the feature (there is
  always a live window), but set `enabled` to `false` if you would rather your
  windows line up with when you actually start working.

The ping runs from the OS temp dir, so no workspace `CLAUDE.md` or repo context
is pulled into it.

## Continue work the limit cut off

When Claude runs out of 5h quota mid-task it stops where it stands and writes
`You've hit your session limit · resets 6:10am` into the session transcript. The
extension notices, and once a fresh window is open it re-launches **that same
session** with a "carry on from where you stopped" prompt, so Claude reads its
own history instead of starting over.

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

`terminal` mode is the default because you can watch what Claude is doing and
answer its permission prompts. `headless` mode keeps working while you are away
from the machine, but nothing can answer a prompt for it: raise `permissionMode`
to `acceptEdits` or higher, or the resume stalls on the first tool call that
needs approval. `bypassPermissions` means unattended edits and shell commands, so
choose it deliberately.

Either way, the 5h tooltip tells you what is waiting before anything runs.

## How it works

Usage data comes from an **undocumented, internal control-protocol request**
(`get_usage`) sent to the `claude` CLI binary bundled inside the official
[Anthropic Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code)
extension. It reuses your existing Claude Code login, so there is no separate
auth and no API key.

**That request is explicitly marked
`EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` in Anthropic's own
source.** It could change or disappear in any Claude Code release with no
warning. When it does, the extension shows a warning icon rather than breaking
outright, but nothing guarantees the data source keeps working at all.

Interrupted-work detection reads a second undocumented surface: the session
transcripts under `~/.claude/projects/*/*.jsonl`, looking for the synthetic
`rate_limit` entry Claude Code writes when quota runs out. That format is
internal too. If it changes, the extension stops finding interrupted sessions and
falls back to the plain reset ping rather than misfiring.

This is an unofficial extension, not affiliated with Anthropic.

## Development

```bash
npm run watch    # incremental compile
npm test         # transcript-scanning tests, on the node:test runner
npx @vscode/vsce package
```

Bump `version` in `package.json` before reinstalling a new build
(`npm version patch --no-git-tag-version` covers `package-lock.json` too). VS
Code upgrades an extension only when the `.vsix` version is higher than the
installed one, so a rebuild under the same number silently leaves the old code in
place. To reinstall a version you already have, pass `--force`.

## License

MIT
