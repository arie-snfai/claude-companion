# Claude Usage Status Bar

A standalone VS Code extension that shows your Claude Code **session (5h)** and
**weekly (7d)** usage as progress bars in the status bar, color-coded by burn
rate rather than raw percentage.

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

## Requirements

- The [Anthropic Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code)
  extension must be installed and logged in.

## Install

Grab the `.vsix` from [Releases](https://github.com/arie-snfai/claude-usage-statusbar/releases)
(or build it yourself, see below), then:

- VS Code UI: Extensions view → `...` menu → **"Install from VSIX..."**
- CLI: `code --install-extension claude-usage-statusbar-*.vsix`

Reload the window afterwards.

## Build from source

```bash
npm install
npm run compile
npx @vscode/vsce package
code --install-extension claude-usage-statusbar-*.vsix
```

## License

MIT
