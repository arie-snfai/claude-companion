import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * The bundled CLI version ships with the VS Code extension and is known to
 * support the `get_usage` control request; a separately-installed `claude`
 * on PATH may be older and lack it, so prefer the bundled one when present.
 */
export function findClaudeBinary(): string {
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
