import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const PDF_ACTIONS = ["read", "info", "extract_pages", "merge", "add_text", "remove_pages"] as const;

const PdfToolSchema = Type.Object({
  action: optionalStringEnum(PDF_ACTIONS),
  path: Type.Optional(Type.String({ description: "Path to the input PDF file" })),
  outputPath: Type.Optional(
    Type.String({ description: "Path for output PDF (defaults to overwrite)" }),
  ),
  pages: Type.Optional(
    Type.String({
      description: "Page range (e.g. '1-3', '1,3,5', '2-'). 1-indexed.",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Array of PDF paths for merge action" }),
  ),
  text: Type.Optional(Type.String({ description: "Text to add (for add_text action)" })),
  page: Type.Optional(
    Type.Number({ description: "Page number for add_text (1-indexed, default 1)" }),
  ),
  x: Type.Optional(Type.Number({ description: "X position for add_text (default 50)" })),
  y: Type.Optional(
    Type.Number({ description: "Y position from bottom for add_text (default 50)" }),
  ),
  fontSize: Type.Optional(Type.Number({ description: "Font size for add_text (default 12)" })),
  maxPages: Type.Optional(Type.Number({ description: "Max pages to read (default 50)" })),
  maxCharsPerPage: Type.Optional(
    Type.Number({ description: "Max chars per page for read (default 5000)" }),
  ),
});

function parsePageRange(rangeStr: string, totalPages: number): number[] {
  const pages: Set<number> = new Set();
  for (const part of rangeStr.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes("-")) {
      const [startStr, endStr] = trimmed.split("-");
      const start = startStr?.trim() ? Number.parseInt(startStr.trim(), 10) : 1;
      const end = endStr?.trim() ? Number.parseInt(endStr.trim(), 10) : totalPages;
      for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
        pages.add(i);
      }
    } else {
      const p = Number.parseInt(trimmed, 10);
      if (p >= 1 && p <= totalPages) {
        pages.add(p);
      }
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}

async function loadPdfJs() {
  return await import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function loadPdfLib() {
  return await import("pdf-lib");
}

async function readPdfText(
  filePath: string,
  opts: { maxPages: number; maxCharsPerPage: number; pageRange?: string },
): Promise<{ pages: Array<{ page: number; text: string }>; totalPages: number }> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const totalPages = doc.numPages;

  const targetPages = opts.pageRange
    ? parsePageRange(opts.pageRange, totalPages)
    : Array.from({ length: Math.min(totalPages, opts.maxPages) }, (_, i) => i + 1);

  const pages: Array<{ page: number; text: string }> = [];
  for (const pageNum of targetPages) {
    if (pageNum > totalPages) break;
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    let text = content.items
      .filter((item): item is { str: string } => "str" in item)
      .map((item) => item.str)
      .join(" ");
    if (text.length > opts.maxCharsPerPage) {
      text = text.slice(0, opts.maxCharsPerPage) + "... [truncated]";
    }
    pages.push({ page: pageNum, text });
  }
  return { pages, totalPages };
}

async function getPdfInfo(filePath: string): Promise<Record<string, unknown>> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const metadata = await doc.getMetadata();
  const stat = await fs.stat(filePath);
  return {
    totalPages: doc.numPages,
    fileSizeBytes: stat.size,
    fileSizeKb: Math.round(stat.size / 1024),
    info: metadata.info,
    metadata: metadata.metadata?.getAll() ?? null,
  };
}

async function extractPages(
  inputPath: string,
  outputPath: string,
  pageRange: string,
): Promise<{ outputPath: string; extractedPages: number[] }> {
  const pdfLib = await loadPdfLib();
  const inputBytes = await fs.readFile(inputPath);
  const srcDoc = await pdfLib.PDFDocument.load(inputBytes);
  const totalPages = srcDoc.getPageCount();
  const pages = parsePageRange(pageRange, totalPages);

  const newDoc = await pdfLib.PDFDocument.create();
  const copiedPages = await newDoc.copyPages(
    srcDoc,
    pages.map((p) => p - 1),
  );
  for (const page of copiedPages) {
    newDoc.addPage(page);
  }
  const outBytes = await newDoc.save();
  await fs.writeFile(outputPath, outBytes);
  return { outputPath, extractedPages: pages };
}

async function mergePdfs(
  inputPaths: string[],
  outputPath: string,
): Promise<{ outputPath: string; mergedCount: number; totalPages: number }> {
  const pdfLib = await loadPdfLib();
  const merged = await pdfLib.PDFDocument.create();
  for (const inputPath of inputPaths) {
    const bytes = await fs.readFile(inputPath);
    const doc = await pdfLib.PDFDocument.load(bytes);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of pages) {
      merged.addPage(page);
    }
  }
  const outBytes = await merged.save();
  await fs.writeFile(outputPath, outBytes);
  return {
    outputPath,
    mergedCount: inputPaths.length,
    totalPages: merged.getPageCount(),
  };
}

async function addText(
  inputPath: string,
  outputPath: string,
  opts: { text: string; page: number; x: number; y: number; fontSize: number },
): Promise<{ outputPath: string }> {
  const pdfLib = await loadPdfLib();
  const bytes = await fs.readFile(inputPath);
  const doc = await pdfLib.PDFDocument.load(bytes);
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  const pageIndex = opts.page - 1;
  if (pageIndex < 0 || pageIndex >= doc.getPageCount()) {
    throw new Error(`Page ${opts.page} out of range (1-${doc.getPageCount()})`);
  }
  const pdfPage = doc.getPage(pageIndex);
  pdfPage.drawText(opts.text, {
    x: opts.x,
    y: opts.y,
    size: opts.fontSize,
    font,
    color: pdfLib.rgb(0, 0, 0),
  });
  const outBytes = await doc.save();
  await fs.writeFile(outputPath, outBytes);
  return { outputPath };
}

async function removePages(
  inputPath: string,
  outputPath: string,
  pageRange: string,
): Promise<{ outputPath: string; removedPages: number[]; remainingPages: number }> {
  const pdfLib = await loadPdfLib();
  const bytes = await fs.readFile(inputPath);
  const doc = await pdfLib.PDFDocument.load(bytes);
  const totalPages = doc.getPageCount();
  const toRemove = new Set(parsePageRange(pageRange, totalPages));

  // Remove in reverse order to keep indices stable
  const sorted = Array.from(toRemove).sort((a, b) => b - a);
  for (const pageNum of sorted) {
    doc.removePage(pageNum - 1);
  }
  const outBytes = await doc.save();
  await fs.writeFile(outputPath, outBytes);
  return {
    outputPath,
    removedPages: Array.from(toRemove).sort((a, b) => a - b),
    remainingPages: doc.getPageCount(),
  };
}

export function createPdfTool(): AnyAgentTool {
  return {
    label: "PDF",
    name: "pdf",
    description: [
      "Read, inspect, and edit PDF files locally (no cloud).",
      "Actions: read (extract text), info (metadata/page count),",
      "extract_pages (copy pages to new PDF), merge (combine PDFs),",
      "add_text (stamp text on a page), remove_pages (delete pages).",
      "Default action is read.",
    ].join(" "),
    parameters: PdfToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim() ? params.action.trim() : "read";

      switch (action) {
        case "read": {
          const filePath = readStringParam(params, "path", { required: true });
          const maxPages =
            typeof params.maxPages === "number" && Number.isFinite(params.maxPages)
              ? Math.max(1, Math.min(500, Math.trunc(params.maxPages)))
              : 50;
          const maxCharsPerPage =
            typeof params.maxCharsPerPage === "number" && Number.isFinite(params.maxCharsPerPage)
              ? Math.max(100, Math.min(50000, Math.trunc(params.maxCharsPerPage)))
              : 5000;
          const pageRange =
            typeof params.pages === "string" && params.pages.trim()
              ? params.pages.trim()
              : undefined;

          const result = await readPdfText(filePath, { maxPages, maxCharsPerPage, pageRange });
          const fullText = result.pages
            .map((p) => `--- Page ${p.page} ---\n${p.text}`)
            .join("\n\n");
          return {
            content: [{ type: "text", text: fullText }],
            details: {
              totalPages: result.totalPages,
              pagesRead: result.pages.length,
              path: filePath,
            },
          };
        }

        case "info": {
          const filePath = readStringParam(params, "path", { required: true });
          const info = await getPdfInfo(filePath);
          return jsonResult(info);
        }

        case "extract_pages": {
          const filePath = readStringParam(params, "path", { required: true });
          const pageRange = readStringParam(params, "pages", { required: true });
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : filePath.replace(/\.pdf$/i, "-extracted.pdf");
          const result = await extractPages(filePath, outputPath, pageRange);
          return jsonResult(result);
        }

        case "merge": {
          const inputPaths = params.paths;
          if (!Array.isArray(inputPaths) || inputPaths.length < 2) {
            throw new Error("paths array with at least 2 PDFs required for merge");
          }
          const paths = inputPaths
            .filter((p): p is string => typeof p === "string")
            .map((p) => p.trim())
            .filter(Boolean);
          if (paths.length < 2) {
            throw new Error("At least 2 valid PDF paths required for merge");
          }
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : path.join(path.dirname(paths[0]), `merged-${Date.now()}.pdf`);
          const result = await mergePdfs(paths, outputPath);
          return jsonResult(result);
        }

        case "add_text": {
          const filePath = readStringParam(params, "path", { required: true });
          const text = readStringParam(params, "text", { required: true });
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : filePath;
          const page =
            typeof params.page === "number" && Number.isFinite(params.page)
              ? Math.max(1, Math.trunc(params.page))
              : 1;
          const x = typeof params.x === "number" && Number.isFinite(params.x) ? params.x : 50;
          const y = typeof params.y === "number" && Number.isFinite(params.y) ? params.y : 50;
          const fontSize =
            typeof params.fontSize === "number" && Number.isFinite(params.fontSize)
              ? params.fontSize
              : 12;
          const result = await addText(filePath, outputPath, {
            text,
            page,
            x,
            y,
            fontSize,
          });
          return jsonResult({ ok: true, ...result });
        }

        case "remove_pages": {
          const filePath = readStringParam(params, "path", { required: true });
          const pageRange = readStringParam(params, "pages", { required: true });
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : filePath;
          const result = await removePages(filePath, outputPath, pageRange);
          return jsonResult(result);
        }

        default:
          throw new Error(`Unknown pdf action: ${action}`);
      }
    },
  };
}
