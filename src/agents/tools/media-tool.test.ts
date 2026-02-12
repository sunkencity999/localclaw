import { execFileSync } from "node:child_process";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { createMediaTool } from "./media-tool.js";

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !hasFfmpeg();

describe("media tool", () => {
  const tool = createMediaTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("media");
    expect(tool.parameters).toBeDefined();
  });

  describe.skipIf(SKIP)("with ffmpeg available", () => {
    it("probes a generated test file", async () => {
      // Create a 1-second test video using ffmpeg
      const testPath = `${os.tmpdir()}/localclaw-media-test-${Date.now()}.mp4`;
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=duration=1:size=320x240:rate=10",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-c:a",
          "aac",
          "-shortest",
          testPath,
        ],
        { timeout: 15000 },
      );

      const result = await tool.execute("call-1", { action: "probe", path: testPath });
      const details = result.details as Record<string, unknown>;
      expect(details.video).toBeDefined();
      expect(details.audio).toBeDefined();

      const video = details.video as Record<string, unknown>;
      expect(video.width).toBe(320);
      expect(video.height).toBe(240);

      // Cleanup
      const fs = await import("node:fs/promises");
      await fs.rm(testPath, { force: true });
    });
  });
});
