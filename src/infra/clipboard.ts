import { runCommandWithTimeout } from "../process/exec.js";

export async function readFromClipboard(): Promise<string | null> {
  const attempts: Array<{ argv: string[] }> = [
    { argv: ["pbpaste"] },
    { argv: ["xclip", "-selection", "clipboard", "-o"] },
    { argv: ["wl-paste"] },
    { argv: ["powershell", "-NoProfile", "-Command", "Get-Clipboard"] },
  ];
  for (const attempt of attempts) {
    try {
      const result = await runCommandWithTimeout(attempt.argv, {
        timeoutMs: 3_000,
      });
      if (result.code === 0 && !result.killed && result.stdout) {
        return result.stdout;
      }
    } catch {
      // keep trying the next fallback
    }
  }
  return null;
}

export async function copyToClipboard(value: string): Promise<boolean> {
  const attempts: Array<{ argv: string[] }> = [
    { argv: ["pbcopy"] },
    { argv: ["xclip", "-selection", "clipboard"] },
    { argv: ["wl-copy"] },
    { argv: ["clip.exe"] }, // WSL / Windows
    { argv: ["powershell", "-NoProfile", "-Command", "Set-Clipboard"] },
  ];
  for (const attempt of attempts) {
    try {
      const result = await runCommandWithTimeout(attempt.argv, {
        timeoutMs: 3_000,
        input: value,
      });
      if (result.code === 0 && !result.killed) {
        return true;
      }
    } catch {
      // keep trying the next fallback
    }
  }
  return false;
}
