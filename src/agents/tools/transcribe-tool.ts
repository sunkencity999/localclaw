import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const execFileAsync = promisify(execFile);

const TRANSCRIBE_ACTIONS = ["transcribe", "detect_capabilities", "convert_audio"] as const;

const TranscribeToolSchema = Type.Object({
  action: optionalStringEnum(TRANSCRIBE_ACTIONS),
  path: Type.Optional(Type.String({ description: "Path to audio/video file to transcribe" })),
  outputPath: Type.Optional(
    Type.String({ description: "Path for converted audio output (convert_audio action)" }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Whisper model name (default: base.en). Options: tiny, tiny.en, base, base.en, small, small.en, medium, medium.en, large",
    }),
  ),
  language: Type.Optional(
    Type.String({
      description: "Language code (e.g. 'en', 'es', 'fr'). Auto-detected if omitted.",
    }),
  ),
  format: Type.Optional(
    Type.String({ description: "Output audio format for convert_audio (default: wav)" }),
  ),
});

async function checkWhisper(): Promise<{ available: boolean; binary: string }> {
  // Try multiple common whisper binary names
  const binaries = ["whisper-cpp", "whisper", "main"];
  for (const bin of binaries) {
    try {
      await execFileAsync(bin, ["--help"], { timeout: 3000 });
      return { available: true, binary: bin };
    } catch {
      // Try next
    }
  }
  return { available: false, binary: "" };
}

async function checkFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    ["-i", inputPath, "-y", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath],
    { timeout: 60_000 },
  );
}

async function transcribeWithWhisper(
  audioPath: string,
  opts: { binary: string; model: string; language?: string },
): Promise<{ text: string; durationMs: number }> {
  const startedAt = Date.now();

  // Ensure wav format for whisper-cpp (16kHz mono)
  const ext = path.extname(audioPath).toLowerCase();
  let wavPath = audioPath;
  let needsCleanup = false;

  if (ext !== ".wav") {
    const hasFfmpeg = await checkFfmpeg();
    if (!hasFfmpeg) {
      throw new Error(
        "Input is not .wav and ffmpeg is not available for conversion. " +
          "Convert to 16kHz mono WAV first, or install ffmpeg.",
      );
    }
    wavPath = path.join(os.tmpdir(), `localclaw-stt-${Date.now()}.wav`);
    await convertToWav(audioPath, wavPath);
    needsCleanup = true;
  }

  try {
    const args = ["-m", opts.model, "-f", wavPath, "--output-txt"];
    if (opts.language) {
      args.push("-l", opts.language);
    }

    const { stdout, stderr } = await execFileAsync(opts.binary, args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    // whisper-cpp outputs to <input>.txt
    const txtPath = `${wavPath}.txt`;
    let text: string;
    try {
      text = (await fs.readFile(txtPath, "utf-8")).trim();
      await fs.rm(txtPath, { force: true }).catch(() => {});
    } catch {
      text = (stdout || stderr || "").trim();
    }

    return { text, durationMs: Date.now() - startedAt };
  } finally {
    if (needsCleanup) {
      await fs.rm(wavPath, { force: true }).catch(() => {});
    }
  }
}

export function createTranscribeTool(): AnyAgentTool {
  return {
    label: "Transcribe",
    name: "transcribe",
    description: [
      "Transcribe audio/video files to text using local whisper.cpp (offline, no cloud).",
      "Actions: transcribe (audio/video→text), detect_capabilities (check what is available),",
      "convert_audio (convert to whisper-compatible WAV using ffmpeg).",
      "Automatically converts non-WAV formats via ffmpeg before transcription.",
      "Requires whisper-cpp on PATH. Install: brew install whisper-cpp (macOS).",
    ].join(" "),
    parameters: TranscribeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim()
          ? params.action.trim()
          : "transcribe";

      switch (action) {
        case "detect_capabilities": {
          const whisper = await checkWhisper();
          const ffmpeg = await checkFfmpeg();
          const systemTts = process.platform === "darwin";

          return jsonResult({
            whisper: whisper.available
              ? { available: true, binary: whisper.binary }
              : {
                  available: false,
                  installHint: "brew install whisper-cpp (macOS) or build from source",
                },
            ffmpeg: ffmpeg
              ? { available: true }
              : {
                  available: false,
                  installHint: "brew install ffmpeg (macOS) or apt install ffmpeg (Linux)",
                },
            systemTts: systemTts ? { available: true, command: "say" } : { available: false },
          });
        }

        case "transcribe": {
          const filePath = readStringParam(params, "path", { required: true });
          const whisper = await checkWhisper();
          if (!whisper.available) {
            throw new Error(
              "whisper-cpp not found on PATH. Install: brew install whisper-cpp (macOS) or build from source. " +
                "See https://github.com/ggerganov/whisper.cpp",
            );
          }

          const model =
            typeof params.model === "string" && params.model.trim()
              ? params.model.trim()
              : "base.en";
          const language =
            typeof params.language === "string" && params.language.trim()
              ? params.language.trim()
              : undefined;

          const result = await transcribeWithWhisper(filePath, {
            binary: whisper.binary,
            model,
            language,
          });

          return {
            content: [{ type: "text", text: result.text }],
            details: {
              path: filePath,
              model,
              language: language ?? "auto",
              durationMs: result.durationMs,
              charCount: result.text.length,
              wordCount: result.text.split(/\s+/).filter(Boolean).length,
            },
          };
        }

        case "convert_audio": {
          const filePath = readStringParam(params, "path", { required: true });
          const hasFfmpeg = await checkFfmpeg();
          if (!hasFfmpeg) {
            throw new Error("ffmpeg not found on PATH. Install: brew install ffmpeg");
          }

          const format =
            typeof params.format === "string" && params.format.trim()
              ? params.format.trim()
              : "wav";
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : filePath.replace(/\.[^.]+$/, `.${format}`);

          if (format === "wav") {
            // Convert to whisper-compatible format: 16kHz mono PCM
            await convertToWav(filePath, outputPath);
          } else {
            await execFileAsync("ffmpeg", ["-i", filePath, "-y", outputPath], { timeout: 60_000 });
          }

          const stat = await fs.stat(outputPath);
          return jsonResult({
            outputPath,
            format,
            sizeMb: Math.round((stat.size / 1024 / 1024) * 100) / 100,
          });
        }

        default:
          throw new Error(`Unknown transcribe action: ${action}`);
      }
    },
  };
}
