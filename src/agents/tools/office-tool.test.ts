import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOfficeTool } from "./office-tool.js";

describe("office tool", () => {
  const tool = createOfficeTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "office-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("has correct name and schema", () => {
    expect(tool.name).toBe("office");
    expect(tool.parameters).toBeDefined();
  });

  it("creates and reads a docx", async () => {
    const outPath = path.join(tmpDir, "test.docx");
    const createResult = await tool.execute("call-1", {
      action: "create_docx",
      outputPath: outPath,
      title: "Test Document",
      content: "# Heading One\n\nThis is a paragraph.\n\n- Bullet item\n- Another item",
    });
    const createDetails = createResult.details as Record<string, unknown>;
    expect(createDetails.ok).toBe(true);

    const readResult = await tool.execute("call-2", { path: outPath });
    const text = readResult.content?.[0];
    expect(text).toBeDefined();
    if (text && "text" in text) {
      expect(text.text).toContain("Test Document");
      expect(text.text).toContain("Heading One");
      expect(text.text).toContain("paragraph");
    }
  });

  it("creates and reads an xlsx", async () => {
    const outPath = path.join(tmpDir, "test.xlsx");
    const createResult = await tool.execute("call-3", {
      action: "create_xlsx",
      outputPath: outPath,
      rows: [
        ["Name", "Age", "City"],
        ["Alice", "30", "Portland"],
        ["Bob", "25", "Seattle"],
      ],
      sheetName: "People",
    });
    const createDetails = createResult.details as Record<string, unknown>;
    expect(createDetails.ok).toBe(true);
    expect(createDetails.rowCount).toBe(3);

    const readResult = await tool.execute("call-4", { path: outPath });
    const details = readResult.details as Record<string, unknown>;
    expect(details.sheetName).toBe("People");
    expect(details.headers).toEqual(["Name", "Age", "City"]);
    expect(details.rowsReturned).toBe(3);

    const text = readResult.content?.[0];
    if (text && "text" in text) {
      expect(text.text).toContain("Alice");
      expect(text.text).toContain("Portland");
    }
  });

  it("gets file info for docx", async () => {
    const outPath = path.join(tmpDir, "info.docx");
    await tool.execute("call-5", {
      action: "create_docx",
      outputPath: outPath,
      content: "Hello world\n\nSecond paragraph",
    });

    const result = await tool.execute("call-6", {
      action: "info",
      path: outPath,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.ext).toBe(".docx");
    expect(details.fileSizeBytes).toBeGreaterThan(0);
    expect(details.paragraphs).toBeGreaterThan(0);
  });

  it("gets file info for xlsx", async () => {
    const outPath = path.join(tmpDir, "info.xlsx");
    await tool.execute("call-7", {
      action: "create_xlsx",
      outputPath: outPath,
      rows: [
        ["A", "B"],
        ["1", "2"],
      ],
    });

    const result = await tool.execute("call-8", {
      action: "info",
      path: outPath,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.ext).toBe(".xlsx");
    expect(details.sheetCount).toBe(1);
  });

  it("auto-detects action from extension", async () => {
    const outPath = path.join(tmpDir, "auto.docx");
    await tool.execute("call-9", {
      action: "create_docx",
      outputPath: outPath,
      content: "Auto-detect test",
    });

    // No action specified — should auto-detect read_docx from .docx extension
    const result = await tool.execute("call-10", { path: outPath });
    const text = result.content?.[0];
    if (text && "text" in text) {
      expect(text.text).toContain("Auto-detect");
    }
  });
});
