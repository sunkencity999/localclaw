import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const execFileAsync = promisify(execFile);

const MEDIA_ACTIONS = [
  "extract_frames",
  "extract_clip",
  "extract_audio",
  "probe",
  "thumbnail",
  "convert",
] as const;

const MediaToolSchema = Type.Object({
  action: optionalStringEnum(MEDIA_ACTIONS),
  path: Type.Optional(Type.String({ description: "Path to the input media file" })),
  outputPath: Type.Optional(Type.String({ description: "Path for output file" })),
  outputDir: Type.Optional(
    Type.String({ description: "Directory for extracted frames (default: temp dir)" }),
  ),
  startTime: Type.Optional(
    Type.String({ description: "Start time (e.g. '00:01:30' or '90' for seconds)" }),
  ),
  duration: Type.Optional(
    Type.String({ description: "Duration (e.g. '5' for 5 seconds, '00:00:10')" }),
  ),
  fps: Type.Optional(Type.Number({ description: "Frames per second for extraction (default 1)" })),
  maxFrames: Type.Optional(Type.Number({ description: "Max frames to extract (default 10)" })),
  format: Type.Optional(
    Type.String({ description: "Output format (e.g. 'jpg', 'png', 'mp3', 'wav')" }),
  ),
  width: Type.Optional(Type.Number({ description: "Output width in pixels" })),
  height: Type.Optional(Type.Number({ description: "Output height in pixels" })),
  quality: Type.Optional(
    Type.Number({ description: "Quality (1-31 for jpg, lower=better; default 5)" }),
  ),
});

async function assertFfmpeg(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    const versionMatch = stdout.match(/ffmpeg version (\S+)/);
    return versionMatch ? versionMatch[1] : "unknown";
  } catch {
    throw new Error(
      "ffmpeg not found on PATH. Install it: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)",
    );
  }
}

async function ffmpeg(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync("ffmpeg", args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout || stderr;
}

async function ffprobe(filePath: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { timeout: 15_000 },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

function resolveOutputDir(custom?: string): string {
  if (custom?.trim()) return custom.trim();
  return path.join(os.tmpdir(), `localclaw-frames-${Date.now()}`);
}

function buildScaleFilter(width?: number, height?: number): string | null {
  if (width && height) return `scale=${width}:${height}`;
  if (width) return `scale=${width}:-1`;
  if (height) return `scale=-1:${height}`;
  return null;
}

export function createMediaTool(): AnyAgentTool {
  return {
    label: "Media",
    name: "media",
    description: [
      "Extract frames, clips, and audio from video/audio files using ffmpeg.",
      "Actions: extract_frames (video→images), extract_clip (cut a segment),",
      "extract_audio (video→audio), probe (get media info), thumbnail (single frame),",
      "convert (transcode/resize).",
      "Requires ffmpeg on PATH.",
    ].join(" "),
    parameters: MediaToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim() ? params.action.trim() : "probe";

      await assertFfmpeg();

      switch (action) {
        case "probe": {
          const filePath = readStringParam(params, "path", { required: true });
          const info = await ffprobe(filePath);
          // Extract key details for a readable summary
          const format = info.format as Record<string, unknown> | undefined;
          const streams = (info.streams ?? []) as Array<Record<string, unknown>>;
          const videoStream = streams.find((s) => s.codec_type === "video");
          const audioStream = streams.find((s) => s.codec_type === "audio");

          return jsonResult({
            duration: format?.duration,
            sizeMb: format?.size
              ? Math.round((Number(format.size) / 1024 / 1024) * 100) / 100
              : undefined,
            bitRate: format?.bit_rate,
            formatName: format?.format_name,
            video: videoStream
              ? {
                  codec: videoStream.codec_name,
                  width: videoStream.width,
                  height: videoStream.height,
                  fps: videoStream.r_frame_rate,
                  bitRate: videoStream.bit_rate,
                }
              : null,
            audio: audioStream
              ? {
                  codec: audioStream.codec_name,
                  sampleRate: audioStream.sample_rate,
                  channels: audioStream.channels,
                  bitRate: audioStream.bit_rate,
                }
              : null,
            streamCount: streams.length,
          });
        }

        case "extract_frames": {
          const filePath = readStringParam(params, "path", { required: true });
          const outputDir = resolveOutputDir(
            typeof params.outputDir === "string" ? params.outputDir : undefined,
          );
          await fs.mkdir(outputDir, { recursive: true });

          const fps =
            typeof params.fps === "number" && Number.isFinite(params.fps)
              ? Math.max(0.1, Math.min(30, params.fps))
              : 1;
          const maxFrames =
            typeof params.maxFrames === "number" && Number.isFinite(params.maxFrames)
              ? Math.max(1, Math.min(100, Math.trunc(params.maxFrames)))
              : 10;
          const format =
            typeof params.format === "string" && params.format.trim()
              ? params.format.trim()
              : "jpg";
          const quality =
            typeof params.quality === "number" && Number.isFinite(params.quality)
              ? Math.max(1, Math.min(31, Math.trunc(params.quality)))
              : 5;

          const ffmpegArgs = ["-i", filePath, "-y"];
          if (typeof params.startTime === "string" && params.startTime.trim()) {
            ffmpegArgs.push("-ss", params.startTime.trim());
          }
          if (typeof params.duration === "string" && params.duration.trim()) {
            ffmpegArgs.push("-t", params.duration.trim());
          }

          const filters: string[] = [`fps=${fps}`];
          const scale = buildScaleFilter(
            typeof params.width === "number" ? params.width : undefined,
            typeof params.height === "number" ? params.height : undefined,
          );
          if (scale) filters.push(scale);

          ffmpegArgs.push("-vf", filters.join(","));
          ffmpegArgs.push("-frames:v", String(maxFrames));
          if (format === "jpg" || format === "jpeg") {
            ffmpegArgs.push("-q:v", String(quality));
          }
          ffmpegArgs.push(path.join(outputDir, `frame-%04d.${format}`));

          await ffmpeg(ffmpegArgs);

          // List extracted frames
          const files = (await fs.readdir(outputDir)).filter((f) => f.startsWith("frame-")).sort();

          return jsonResult({
            outputDir,
            frameCount: files.length,
            frames: files.map((f) => path.join(outputDir, f)),
            format,
          });
        }

        case "thumbnail": {
          const filePath = readStringParam(params, "path", { required: true });
          const format =
            typeof params.format === "string" && params.format.trim()
              ? params.format.trim()
              : "jpg";
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : path.join(os.tmpdir(), `localclaw-thumb-${Date.now()}.${format}`);
          const startTime =
            typeof params.startTime === "string" && params.startTime.trim()
              ? params.startTime.trim()
              : "00:00:01";

          const ffmpegArgs = ["-i", filePath, "-y", "-ss", startTime, "-frames:v", "1"];
          const scale = buildScaleFilter(
            typeof params.width === "number" ? params.width : undefined,
            typeof params.height === "number" ? params.height : undefined,
          );
          if (scale) {
            ffmpegArgs.push("-vf", scale);
          }
          ffmpegArgs.push(outputPath);
          await ffmpeg(ffmpegArgs);

          return jsonResult({ outputPath, format });
        }

        case "extract_clip": {
          const filePath = readStringParam(params, "path", { required: true });
          const startTime = readStringParam(params, "startTime", { required: true });
          const duration = readStringParam(params, "duration", { required: true });
          const format =
            typeof params.format === "string" && params.format.trim()
              ? params.format.trim()
              : path.extname(filePath).slice(1) || "mp4";
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : path.join(os.tmpdir(), `localclaw-clip-${Date.now()}.${format}`);

          const ffmpegArgs = [
            "-i",
            filePath,
            "-y",
            "-ss",
            startTime,
            "-t",
            duration,
            "-c",
            "copy",
            outputPath,
          ];
          await ffmpeg(ffmpegArgs);
          const stat = await fs.stat(outputPath);

          return jsonResult({
            outputPath,
            sizeMb: Math.round((stat.size / 1024 / 1024) * 100) / 100,
          });
        }

        case "extract_audio": {
          const filePath = readStringParam(params, "path", { required: true });
          const format =
            typeof params.format === "string" && params.format.trim()
              ? params.format.trim()
              : "mp3";
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : path.join(os.tmpdir(), `localclaw-audio-${Date.now()}.${format}`);

          const ffmpegArgs = ["-i", filePath, "-y", "-vn"];
          if (typeof params.startTime === "string" && params.startTime.trim()) {
            ffmpegArgs.push("-ss", params.startTime.trim());
          }
          if (typeof params.duration === "string" && params.duration.trim()) {
            ffmpegArgs.push("-t", params.duration.trim());
          }
          ffmpegArgs.push(outputPath);
          await ffmpeg(ffmpegArgs);
          const stat = await fs.stat(outputPath);

          return jsonResult({
            outputPath,
            format,
            sizeMb: Math.round((stat.size / 1024 / 1024) * 100) / 100,
          });
        }

        case "convert": {
          const filePath = readStringParam(params, "path", { required: true });
          const format =
            typeof params.format === "string" && params.format.trim()
              ? params.format.trim()
              : "mp4";
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : filePath.replace(/\.[^.]+$/, `.${format}`);

          const ffmpegArgs = ["-i", filePath, "-y"];
          const scale = buildScaleFilter(
            typeof params.width === "number" ? params.width : undefined,
            typeof params.height === "number" ? params.height : undefined,
          );
          if (scale) {
            ffmpegArgs.push("-vf", scale);
          }
          ffmpegArgs.push(outputPath);
          await ffmpeg(ffmpegArgs);
          const stat = await fs.stat(outputPath);

          return jsonResult({
            outputPath,
            format,
            sizeMb: Math.round((stat.size / 1024 / 1024) * 100) / 100,
          });
        }

        default:
          throw new Error(`Unknown media action: ${action}`);
      }
    },
  };
}
