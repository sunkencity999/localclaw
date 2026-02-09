/**
 * Voice pipeline — abstraction for speech-to-text (STT) and
 * text-to-speech (TTS) integration.
 *
 * Supports local whisper.cpp for STT and system TTS (macOS `say`,
 * or configurable external TTS providers).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";

export type SttResult = {
  text: string;
  language?: string;
  durationMs: number;
};

export type TtsResult = {
  audioPath: string;
  format: string;
  durationMs: number;
};

export type VoiceProvider = "system" | "whisper" | "custom";

/**
 * Check if whisper.cpp CLI is available for speech-to-text.
 */
export async function isWhisperAvailable(): Promise<boolean> {
  try {
    const result = await runCommandWithTimeout(["whisper-cpp", "--help"], {
      timeoutMs: 3000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Check if macOS `say` command is available for text-to-speech.
 */
export async function isSystemTtsAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    const result = await runCommandWithTimeout(["which", "say"], {
      timeoutMs: 2000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Transcribe audio to text using whisper.cpp.
 */
export async function transcribeWithWhisper(
  audioPath: string,
  opts?: { model?: string; language?: string },
): Promise<SttResult> {
  const startedAt = Date.now();
  const model = opts?.model ?? "base.en";
  const args = ["-m", model, "-f", audioPath, "--output-txt"];
  if (opts?.language) {
    args.push("-l", opts.language);
  }

  const result = await runCommandWithTimeout(["whisper-cpp", ...args], {
    timeoutMs: 60_000,
  });

  if (result.code !== 0) {
    throw new Error(`whisper-cpp failed: ${result.stderr || "unknown error"}`);
  }

  // whisper-cpp outputs to <input>.txt
  const txtPath = `${audioPath}.txt`;
  let text: string;
  try {
    text = (await fs.readFile(txtPath, "utf-8")).trim();
    await fs.rm(txtPath, { force: true }).catch(() => {});
  } catch {
    // Fall back to stdout
    text = result.stdout?.trim() ?? "";
  }

  return {
    text,
    language: opts?.language,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Convert text to speech using macOS `say` command.
 */
export async function synthesizeWithSystemTts(
  text: string,
  opts?: { voice?: string; rate?: number; outputPath?: string },
): Promise<TtsResult> {
  const startedAt = Date.now();
  const outputPath = opts?.outputPath ?? path.join(os.tmpdir(), `openclaw-tts-${Date.now()}.aiff`);

  const args = ["-o", outputPath];
  if (opts?.voice) {
    args.push("-v", opts.voice);
  }
  if (opts?.rate) {
    args.push("-r", String(opts.rate));
  }
  args.push(text);

  const result = await runCommandWithTimeout(["say", ...args], {
    timeoutMs: 30_000,
  });

  if (result.code !== 0) {
    throw new Error(`say command failed: ${result.stderr || "unknown error"}`);
  }

  return {
    audioPath: outputPath,
    format: "aiff",
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Detect available voice capabilities on this system.
 */
export async function detectVoiceCapabilities(): Promise<{
  stt: VoiceProvider[];
  tts: VoiceProvider[];
}> {
  const stt: VoiceProvider[] = [];
  const tts: VoiceProvider[] = [];

  if (await isWhisperAvailable()) {
    stt.push("whisper");
  }

  if (await isSystemTtsAvailable()) {
    tts.push("system");
  }

  return { stt, tts };
}
