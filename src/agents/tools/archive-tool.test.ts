import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArchiveTool } from "./archive-tool.js";

describe("archive tool", () => {
  const tool = createArchiveTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-test-"));
    // Create test files
    await fs.writeFile(path.join(tmpDir, "file1.txt"), "Hello World");
    await fs.writeFile(path.join(tmpDir, "file2.txt"), "Second file content");
    await fs.mkdir(path.join(tmpDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "subdir", "nested.txt"), "Nested content");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("has correct name and schema", () => {
    expect(tool.name).toBe("archive");
    expect(tool.parameters).toBeDefined();
  });

  it("creates and lists a zip", async () => {
    const zipPath = path.join(tmpDir, "test.zip");
    const createResult = await tool.execute("call-1", {
      action: "create_zip",
      paths: [path.join(tmpDir, "file1.txt"), path.join(tmpDir, "file2.txt")],
      outputPath: zipPath,
    });
    const createDetails = createResult.details as Record<string, unknown>;
    expect(createDetails.fileCount).toBe(2);

    const listResult = await tool.execute("call-2", {
      action: "list_zip",
      path: zipPath,
    });
    const listDetails = listResult.details as Record<string, unknown>;
    expect(listDetails.fileCount).toBe(2);
  });

  it("creates zip with directory and extracts it", async () => {
    const zipPath = path.join(tmpDir, "dir.zip");
    await tool.execute("call-3", {
      action: "create_zip",
      paths: [path.join(tmpDir, "subdir")],
      outputPath: zipPath,
    });

    const extractDir = path.join(tmpDir, "extracted");
    const extractResult = await tool.execute("call-4", {
      action: "extract_zip",
      path: zipPath,
      outputDir: extractDir,
    });
    const extractDetails = extractResult.details as Record<string, unknown>;
    expect(extractDetails.fileCount).toBe(1);

    const content = await fs.readFile(path.join(extractDir, "subdir", "nested.txt"), "utf-8");
    expect(content).toBe("Nested content");
  });

  it("creates and lists a tar.gz", async () => {
    const tarPath = path.join(tmpDir, "test.tar.gz");
    const createResult = await tool.execute("call-5", {
      action: "create_tar",
      paths: [path.join(tmpDir, "file1.txt"), path.join(tmpDir, "file2.txt")],
      outputPath: tarPath,
      compression: "gz",
    });
    const createDetails = createResult.details as Record<string, unknown>;
    expect(createDetails.outputPath).toBe(tarPath);

    const listResult = await tool.execute("call-6", {
      action: "list_tar",
      path: tarPath,
    });
    const listDetails = listResult.details as Record<string, unknown>;
    expect(listDetails.entryCount).toBe(2);
  });

  it("extracts a tar.gz", async () => {
    const tarPath = path.join(tmpDir, "test.tar.gz");
    await tool.execute("call-7", {
      action: "create_tar",
      paths: [path.join(tmpDir, "file1.txt")],
      outputPath: tarPath,
    });

    const extractDir = path.join(tmpDir, "tar-extracted");
    await tool.execute("call-8", {
      action: "extract_tar",
      path: tarPath,
      outputDir: extractDir,
    });

    // tar preserves full paths, so check accordingly
    const entries = await fs.readdir(extractDir, { recursive: true });
    expect(entries.length).toBeGreaterThan(0);
  });

  it("gzips and gunzips a file", async () => {
    const inputPath = path.join(tmpDir, "file1.txt");
    const gzPath = path.join(tmpDir, "file1.txt.gz");

    const gzipResult = await tool.execute("call-9", {
      action: "gzip",
      path: inputPath,
      outputPath: gzPath,
    });
    expect((gzipResult.details as Record<string, unknown>).outputPath).toBe(gzPath);

    const unzippedPath = path.join(tmpDir, "file1-restored.txt");
    await tool.execute("call-10", {
      action: "gunzip",
      path: gzPath,
      outputPath: unzippedPath,
    });

    const content = await fs.readFile(unzippedPath, "utf-8");
    expect(content).toBe("Hello World");
  });
});
