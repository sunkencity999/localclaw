import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const OFFICE_ACTIONS = [
  "read_docx",
  "read_xlsx",
  "read_pptx",
  "create_docx",
  "create_xlsx",
  "info",
] as const;

const OfficeToolSchema = Type.Object({
  action: optionalStringEnum(OFFICE_ACTIONS),
  path: Type.Optional(Type.String({ description: "Path to the input file" })),
  outputPath: Type.Optional(Type.String({ description: "Path for output file" })),
  sheet: Type.Optional(
    Type.String({ description: "Sheet name or index (1-based) for xlsx. Default: first sheet." }),
  ),
  maxRows: Type.Optional(Type.Number({ description: "Max rows to read from xlsx (default 500)" })),
  title: Type.Optional(Type.String({ description: "Document title for create_docx" })),
  content: Type.Optional(
    Type.String({
      description:
        "Text content for create_docx (markdown-like: # for headings, blank lines for paragraphs)",
    }),
  ),
  rows: Type.Optional(
    Type.Array(Type.Array(Type.String()), {
      description: "2D array of strings for create_xlsx (first row = headers)",
    }),
  ),
  sheetName: Type.Optional(
    Type.String({ description: "Sheet name for create_xlsx (default 'Sheet1')" }),
  ),
});

async function readDocx(filePath: string): Promise<{ text: string; paragraphs: number }> {
  const JSZip = (await import("jszip")).default;
  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  const documentXml = zip.file("word/document.xml");
  if (!documentXml) {
    throw new Error("Not a valid .docx file (missing word/document.xml)");
  }
  const xml = await documentXml.async("text");

  // Split on paragraph boundaries: each <w:p>...</w:p> is one paragraph.
  const paragraphRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  const textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  const paragraphs: string[] = [];

  let pMatch: RegExpExecArray | null;
  while ((pMatch = paragraphRegex.exec(xml)) !== null) {
    const pXml = pMatch[0];
    let paragraphText = "";
    let tMatch: RegExpExecArray | null;
    textRegex.lastIndex = 0;
    while ((tMatch = textRegex.exec(pXml)) !== null) {
      paragraphText += tMatch[1];
    }
    if (paragraphText.trim()) {
      paragraphs.push(paragraphText.trim());
    }
  }

  const text = paragraphs.join("\n\n");
  return { text, paragraphs: paragraphs.length };
}

async function readXlsx(
  filePath: string,
  opts: { sheet?: string; maxRows: number },
): Promise<{
  sheetName: string;
  headers: string[];
  rows: string[][];
  totalRows: number;
  totalSheets: number;
  sheetNames: string[];
}> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  let worksheet = workbook.worksheets[0];

  if (opts.sheet) {
    const sheetIndex = Number.parseInt(opts.sheet, 10);
    if (!Number.isNaN(sheetIndex) && sheetIndex >= 1) {
      worksheet = workbook.worksheets[sheetIndex - 1] ?? worksheet;
    } else {
      const found = workbook.worksheets.find(
        (ws) => ws.name.toLowerCase() === opts.sheet!.toLowerCase(),
      );
      if (found) worksheet = found;
    }
  }

  if (!worksheet) {
    throw new Error("No worksheets found in file");
  }

  const rows: string[][] = [];
  let headers: string[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rows.length >= opts.maxRows) return;
    const values = row.values as unknown[];
    // ExcelJS row.values is 1-indexed (index 0 is empty)
    const cells = values.slice(1).map((v) => {
      if (v === null || v === undefined) return "";
      if (typeof v === "object" && v !== null && "text" in v) {
        return String((v as { text: unknown }).text);
      }
      return String(v);
    });
    if (rowNumber === 1) {
      headers = cells;
    }
    rows.push(cells);
  });

  return {
    sheetName: worksheet.name,
    headers,
    rows,
    totalRows: worksheet.rowCount,
    totalSheets: sheetNames.length,
    sheetNames,
  };
}

async function readPptx(
  filePath: string,
): Promise<{ slides: Array<{ slide: number; text: string }> }> {
  const JSZip = (await import("jszip")).default;
  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);

  const slides: Array<{ slide: number; text: string }> = [];
  let slideIndex = 1;

  while (true) {
    const slideFile = zip.file(`ppt/slides/slide${slideIndex}.xml`);
    if (!slideFile) break;
    const xml = await slideFile.async("text");
    // Extract text from <a:t> tags (PowerPoint uses DrawingML namespace)
    const textMatches = xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
    const texts = textMatches.map((t) => {
      const match = t.match(/<a:t>([^<]*)<\/a:t>/);
      return match ? match[1] : "";
    });
    slides.push({ slide: slideIndex, text: texts.join(" ").trim() });
    slideIndex++;
  }

  return { slides };
}

async function createDocx(
  outputPath: string,
  opts: { title?: string; content: string },
): Promise<{ outputPath: string; paragraphs: number }> {
  const docx = await import("docx");
  const lines = opts.content.split("\n");
  const children: InstanceType<typeof docx.Paragraph>[] = [];

  if (opts.title) {
    children.push(
      new docx.Paragraph({
        children: [new docx.TextRun({ text: opts.title, bold: true, size: 32 })],
        heading: docx.HeadingLevel.TITLE,
      }),
    );
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new docx.Paragraph({ children: [] }));
      continue;
    }
    if (trimmed.startsWith("### ")) {
      children.push(
        new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(4), bold: true })],
          heading: docx.HeadingLevel.HEADING_3,
        }),
      );
    } else if (trimmed.startsWith("## ")) {
      children.push(
        new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(3), bold: true })],
          heading: docx.HeadingLevel.HEADING_2,
        }),
      );
    } else if (trimmed.startsWith("# ")) {
      children.push(
        new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(2), bold: true })],
          heading: docx.HeadingLevel.HEADING_1,
        }),
      );
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      children.push(
        new docx.Paragraph({
          children: [new docx.TextRun(trimmed.slice(2))],
          bullet: { level: 0 },
        }),
      );
    } else {
      children.push(new docx.Paragraph({ children: [new docx.TextRun(trimmed)] }));
    }
  }

  const doc = new docx.Document({
    sections: [{ children }],
  });
  const buffer = await docx.Packer.toBuffer(doc);
  await fs.writeFile(outputPath, buffer);
  return { outputPath, paragraphs: children.length };
}

async function createXlsx(
  outputPath: string,
  opts: { rows: string[][]; sheetName: string },
): Promise<{ outputPath: string; rowCount: number; sheetName: string }> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(opts.sheetName);

  for (const row of opts.rows) {
    worksheet.addRow(row);
  }

  // Auto-fit column widths based on content
  if (opts.rows.length > 0) {
    const headers = opts.rows[0];
    for (let i = 0; i < headers.length; i++) {
      const col = worksheet.getColumn(i + 1);
      let maxLen = headers[i].length;
      for (const row of opts.rows) {
        if (row[i] && row[i].length > maxLen) {
          maxLen = row[i].length;
        }
      }
      col.width = Math.min(50, Math.max(10, maxLen + 2));
    }
    // Bold the header row
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
  }

  await workbook.xlsx.writeFile(outputPath);
  return { outputPath, rowCount: opts.rows.length, sheetName: opts.sheetName };
}

async function getFileInfo(filePath: string): Promise<Record<string, unknown>> {
  const stat = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const info: Record<string, unknown> = {
    path: filePath,
    ext,
    fileSizeBytes: stat.size,
    fileSizeKb: Math.round(stat.size / 1024),
  };

  if (ext === ".docx") {
    const result = await readDocx(filePath);
    info.paragraphs = result.paragraphs;
    info.charCount = result.text.length;
  } else if (ext === ".xlsx") {
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    info.sheetCount = workbook.worksheets.length;
    info.sheetNames = workbook.worksheets.map((ws) => ws.name);
    info.rowCounts = workbook.worksheets.map((ws) => ({
      sheet: ws.name,
      rows: ws.rowCount,
    }));
  } else if (ext === ".pptx") {
    const result = await readPptx(filePath);
    info.slideCount = result.slides.length;
  }

  return info;
}

export function createOfficeTool(): AnyAgentTool {
  return {
    label: "Office Docs",
    name: "office",
    description: [
      "Read and create Office documents locally (no cloud).",
      "Actions: read_docx (extract text), read_xlsx (extract rows/headers),",
      "read_pptx (extract slide text), create_docx (from markdown-like text),",
      "create_xlsx (from 2D array), info (file metadata).",
      "Default action is inferred from file extension.",
    ].join(" "),
    parameters: OfficeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      let action =
        typeof params.action === "string" && params.action.trim() ? params.action.trim() : "";

      // Auto-detect action from file extension if not specified
      if (!action) {
        const filePath = typeof params.path === "string" ? params.path.trim() : "";
        const ext = path.extname(filePath).toLowerCase();
        if (ext === ".docx") action = "read_docx";
        else if (ext === ".xlsx" || ext === ".xls") action = "read_xlsx";
        else if (ext === ".pptx") action = "read_pptx";
        else action = "info";
      }

      switch (action) {
        case "read_docx": {
          const filePath = readStringParam(params, "path", { required: true });
          const result = await readDocx(filePath);
          return {
            content: [{ type: "text", text: result.text }],
            details: { paragraphs: result.paragraphs, path: filePath },
          };
        }

        case "read_xlsx": {
          const filePath = readStringParam(params, "path", { required: true });
          const sheet = typeof params.sheet === "string" ? params.sheet.trim() : undefined;
          const maxRows =
            typeof params.maxRows === "number" && Number.isFinite(params.maxRows)
              ? Math.max(1, Math.min(10000, Math.trunc(params.maxRows)))
              : 500;

          const result = await readXlsx(filePath, { sheet, maxRows });

          // Format as a readable table
          const lines = [
            `Sheet: ${result.sheetName} (${result.totalRows} rows, ${result.totalSheets} sheets)`,
            "",
          ];
          if (result.rows.length > 0) {
            lines.push(result.rows.map((row) => row.join("\t")).join("\n"));
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              sheetName: result.sheetName,
              headers: result.headers,
              rowsReturned: result.rows.length,
              totalRows: result.totalRows,
              sheetNames: result.sheetNames,
              path: filePath,
            },
          };
        }

        case "read_pptx": {
          const filePath = readStringParam(params, "path", { required: true });
          const result = await readPptx(filePath);
          const text = result.slides.map((s) => `--- Slide ${s.slide} ---\n${s.text}`).join("\n\n");

          return {
            content: [{ type: "text", text }],
            details: {
              slideCount: result.slides.length,
              path: filePath,
            },
          };
        }

        case "create_docx": {
          const outputPath = readStringParam(params, "outputPath", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const title = typeof params.title === "string" ? params.title.trim() : undefined;
          const result = await createDocx(outputPath, { title, content });
          return jsonResult({ ok: true, ...result });
        }

        case "create_xlsx": {
          const outputPath = readStringParam(params, "outputPath", { required: true });
          const rows = params.rows;
          if (!Array.isArray(rows) || rows.length === 0) {
            throw new Error("rows (2D string array) required for create_xlsx");
          }
          const validRows = rows
            .filter(Array.isArray)
            .map((row) => (row as unknown[]).map((cell) => String(cell ?? "")));
          const sheetName =
            typeof params.sheetName === "string" && params.sheetName.trim()
              ? params.sheetName.trim()
              : "Sheet1";
          const result = await createXlsx(outputPath, {
            rows: validRows,
            sheetName,
          });
          return jsonResult({ ok: true, ...result });
        }

        case "info": {
          const filePath = readStringParam(params, "path", { required: true });
          const info = await getFileInfo(filePath);
          return jsonResult(info);
        }

        default:
          throw new Error(`Unknown office action: ${action}`);
      }
    },
  };
}
