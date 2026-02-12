import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createTranscribeTool } from "./transcribe-tool.js";

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

describe("transcribe tool", () => {
  const tool = createTranscribeTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("transcribe");
    expect(tool.parameters).toBeDefined();
  });

  it("detects capabilities without errors", async () => {
    const result = await tool.execute("call-1", { action: "detect_capabilities" });
    const details = result.details as Record<string, unknown>;
    expect(details.whisper).toBeDefined();
    expect(details.ffmpeg).toBeDefined();
    expect(details.systemTts).toBeDefined();

    const whisper = details.whisper as Record<string, unknown>;
    expect(typeof whisper.available).toBe("boolean");

    const ffmpeg = details.ffmpeg as Record<string, unknown>;
    expect(typeof ffmpeg.available).toBe("boolean");
  });

  describe.skipIf(!hasFfmpeg())("with ffmpeg available", () => {
    it("converts audio format via convert_audio", async () => {
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");

      // Generate a short test tone using ffmpeg
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stt-test-"));
      const mp3Path = path.join(tmpDir, "test.mp3");
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-c:a",
          "libmp3lame",
          "-q:a",
          "9",
          mp3Path,
        ],
        { timeout: 10000 },
      );

      const wavPath = path.join(tmpDir, "test.wav");
      const result = await tool.execute("call-2", {
        action: "convert_audio",
        path: mp3Path,
        outputPath: wavPath,
        format: "wav",
      });
      const details = result.details as Record<string, unknown>;
      expect(details.outputPath).toBe(wavPath);
      expect(details.format).toBe("wav");

      // Verify the WAV file was created
      const stat = await fs.stat(wavPath);
      expect(stat.size).toBeGreaterThan(0);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});
