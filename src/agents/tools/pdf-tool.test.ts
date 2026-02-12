import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPdfTool } from "./pdf-tool.js";

// Helper: create a minimal valid PDF using pdf-lib
async function createTestPdf(filePath: string, pageCount = 3) {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${i} content here`, { x: 50, y: 700, size: 14, font });
  }
  const bytes = await doc.save();
  await fs.writeFile(filePath, bytes);
}

describe("pdf tool", () => {
  const tool = createPdfTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("has correct name and schema", () => {
    expect(tool.name).toBe("pdf");
    expect(tool.parameters).toBeDefined();
  });

  it("reads text from a PDF", async () => {
    const pdfPath = path.join(tmpDir, "test.pdf");
    await createTestPdf(pdfPath);

    const result = await tool.execute("call-1", { path: pdfPath });
    const text = result.content?.[0];
    expect(text).toBeDefined();
    if (text && "text" in text) {
      expect(text.text).toContain("Page 1");
      expect(text.text).toContain("Page 2");
      expect(text.text).toContain("Page 3");
    }
    const details = result.details as Record<string, unknown>;
    expect(details.totalPages).toBe(3);
    expect(details.pagesRead).toBe(3);
  });

  it("reads specific pages", async () => {
    const pdfPath = path.join(tmpDir, "test.pdf");
    await createTestPdf(pdfPath);

    const result = await tool.execute("call-2", { path: pdfPath, pages: "1,3" });
    const details = result.details as Record<string, unknown>;
    expect(details.pagesRead).toBe(2);
  });

  it("gets PDF info", async () => {
    const pdfPath = path.join(tmpDir, "test.pdf");
    await createTestPdf(pdfPath);

    const result = await tool.execute("call-3", { action: "info", path: pdfPath });
    const details = result.details as Record<string, unknown>;
    expect(details.totalPages).toBe(3);
    expect(details.fileSizeBytes).toBeGreaterThan(0);
  });

  it("extracts pages to a new PDF", async () => {
    const pdfPath = path.join(tmpDir, "test.pdf");
    await createTestPdf(pdfPath);
    const outPath = path.join(tmpDir, "extracted.pdf");

    const result = await tool.execute("call-4", {
      action: "extract_pages",
      path: pdfPath,
      pages: "1,3",
      outputPath: outPath,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.outputPath).toBe(outPath);
    expect(details.extractedPages).toEqual([1, 3]);

    // Verify the extracted PDF has 2 pages
    const info = await tool.execute("call-5", { action: "info", path: outPath });
    expect((info.details as Record<string, unknown>).totalPages).toBe(2);
  });

  it("merges PDFs", async () => {
    const pdf1 = path.join(tmpDir, "a.pdf");
    const pdf2 = path.join(tmpDir, "b.pdf");
    await createTestPdf(pdf1, 2);
    await createTestPdf(pdf2, 1);
    const outPath = path.join(tmpDir, "merged.pdf");

    const result = await tool.execute("call-6", {
      action: "merge",
      paths: [pdf1, pdf2],
      outputPath: outPath,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.totalPages).toBe(3);
    expect(details.mergedCount).toBe(2);
  });

  it("adds text to a page", async () => {
    const pdfPath = path.join(tmpDir, "test.pdf");
    await createTestPdf(pdfPath, 1);
    const outPath = path.join(tmpDir, "stamped.pdf");

    const result = await tool.execute("call-7", {
      action: "add_text",
      path: pdfPath,
      text: "WATERMARK",
      page: 1,
      x: 200,
      y: 400,
      fontSize: 24,
      outputPath: outPath,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.ok).toBe(true);

    // Read back and verify the text is present
    const readResult = await tool.execute("call-8", { path: outPath });
    const text = readResult.content?.[0];
    if (text && "text" in text) {
      expect(text.text).toContain("WATERMARK");
    }
  });

  it("removes pages", async () => {
    const pdfPath = path.join(tmpDir, "test.pdf");
    await createTestPdf(pdfPath, 5);
    const outPath = path.join(tmpDir, "trimmed.pdf");

    const result = await tool.execute("call-9", {
      action: "remove_pages",
      path: pdfPath,
      pages: "2,4",
      outputPath: outPath,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.removedPages).toEqual([2, 4]);
    expect(details.remainingPages).toBe(3);
  });
});
