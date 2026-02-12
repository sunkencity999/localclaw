import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGzip, createGunzip } from "node:zlib";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const execFileAsync = promisify(execFile);

const ARCHIVE_ACTIONS = [
  "create_zip",
  "extract_zip",
  "list_zip",
  "create_tar",
  "extract_tar",
  "list_tar",
  "gzip",
  "gunzip",
] as const;

const ArchiveToolSchema = Type.Object({
  action: optionalStringEnum(ARCHIVE_ACTIONS),
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Files/directories to archive (for create actions)" }),
  ),
  path: Type.Optional(
    Type.String({ description: "Path to archive file (for extract/list actions)" }),
  ),
  outputPath: Type.Optional(Type.String({ description: "Output file or directory path" })),
  outputDir: Type.Optional(
    Type.String({ description: "Directory to extract into (default: current dir)" }),
  ),
  compression: Type.Optional(
    Type.String({ description: "Tar compression: gz, bz2, xz, zst, or none (default: gz)" }),
  ),
  stripComponents: Type.Optional(
    Type.Number({ description: "Strip N leading path components on extract (default: 0)" }),
  ),
});

async function createZip(
  inputPaths: string[],
  outputPath: string,
): Promise<{ outputPath: string; fileCount: number; sizeKb: number }> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  let fileCount = 0;

  async function addToZip(fsPath: string, zipPath: string) {
    const stat = await fs.stat(fsPath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(fsPath);
      for (const entry of entries) {
        await addToZip(path.join(fsPath, entry), path.join(zipPath, entry));
      }
    } else {
      const data = await fs.readFile(fsPath);
      zip.file(zipPath, data);
      fileCount++;
    }
  }

  for (const inputPath of inputPaths) {
    const basename = path.basename(inputPath);
    await addToZip(inputPath, basename);
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(outputPath, buffer);
  const stat = await fs.stat(outputPath);

  return {
    outputPath,
    fileCount,
    sizeKb: Math.round(stat.size / 1024),
  };
}

async function extractZip(
  archivePath: string,
  outputDir: string,
): Promise<{ outputDir: string; fileCount: number }> {
  const JSZip = (await import("jszip")).default;
  const data = await fs.readFile(archivePath);
  const zip = await JSZip.loadAsync(data);

  await fs.mkdir(outputDir, { recursive: true });
  let fileCount = 0;

  for (const [relativePath, file] of Object.entries(zip.files)) {
    const fullPath = path.join(outputDir, relativePath);
    if (file.dir) {
      await fs.mkdir(fullPath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      const content = await file.async("nodebuffer");
      await fs.writeFile(fullPath, content);
      fileCount++;
    }
  }

  return { outputDir, fileCount };
}

async function listZip(
  archivePath: string,
): Promise<{ files: Array<{ path: string; size: number; dir: boolean }> }> {
  const JSZip = (await import("jszip")).default;
  const data = await fs.readFile(archivePath);
  const zip = await JSZip.loadAsync(data);

  const files: Array<{ path: string; size: number; dir: boolean }> = [];
  for (const [relativePath, file] of Object.entries(zip.files)) {
    if (file.dir) {
      files.push({ path: relativePath, size: 0, dir: true });
    } else {
      const content = await file.async("nodebuffer");
      files.push({ path: relativePath, size: content.length, dir: false });
    }
  }

  return { files };
}

function tarCompressionFlag(compression: string): string {
  switch (compression) {
    case "gz":
    case "gzip":
      return "z";
    case "bz2":
    case "bzip2":
      return "j";
    case "xz":
      return "J";
    case "zst":
    case "zstd":
      return "--zstd";
    case "none":
    case "":
      return "";
    default:
      return "z";
  }
}

function tarExtension(compression: string): string {
  switch (compression) {
    case "gz":
    case "gzip":
      return ".tar.gz";
    case "bz2":
    case "bzip2":
      return ".tar.bz2";
    case "xz":
      return ".tar.xz";
    case "zst":
    case "zstd":
      return ".tar.zst";
    case "none":
    case "":
      return ".tar";
    default:
      return ".tar.gz";
  }
}

async function createTar(
  inputPaths: string[],
  outputPath: string,
  compression: string,
): Promise<{ outputPath: string; sizeKb: number }> {
  const flag = tarCompressionFlag(compression);
  const args = ["cf" + (flag.startsWith("-") ? "" : flag), outputPath];
  if (flag.startsWith("-")) {
    args.splice(0, 0, flag);
  }
  args.push(...inputPaths);

  await execFileAsync("tar", args, { timeout: 120_000 });
  const stat = await fs.stat(outputPath);
  return { outputPath, sizeKb: Math.round(stat.size / 1024) };
}

async function extractTar(
  archivePath: string,
  outputDir: string,
  stripComponents: number,
): Promise<{ outputDir: string }> {
  await fs.mkdir(outputDir, { recursive: true });
  const args = ["xf", archivePath, "-C", outputDir];
  if (stripComponents > 0) {
    args.push(`--strip-components=${stripComponents}`);
  }
  await execFileAsync("tar", args, { timeout: 120_000 });
  return { outputDir };
}

async function listTar(archivePath: string): Promise<{ entries: string[] }> {
  const { stdout } = await execFileAsync("tar", ["tf", archivePath], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { entries: stdout.trim().split("\n").filter(Boolean) };
}

export function createArchiveTool(): AnyAgentTool {
  return {
    label: "Archive",
    name: "archive",
    description: [
      "Create, extract, and list archive files (zip, tar, gzip).",
      "Actions: create_zip, extract_zip, list_zip, create_tar, extract_tar,",
      "list_tar, gzip (compress single file), gunzip (decompress .gz).",
      "Supports tar with gz/bz2/xz/zst compression.",
    ].join(" "),
    parameters: ArchiveToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim()
          ? params.action.trim()
          : "list_zip";

      switch (action) {
        case "create_zip": {
          const paths = params.paths;
          if (!Array.isArray(paths) || paths.length === 0) {
            throw new Error("paths array required for create_zip");
          }
          const inputPaths = paths
            .filter((p): p is string => typeof p === "string")
            .map((p) => p.trim())
            .filter(Boolean);
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : `archive-${Date.now()}.zip`;
          const result = await createZip(inputPaths, outputPath);
          return jsonResult(result);
        }

        case "extract_zip": {
          const archivePath = readStringParam(params, "path", { required: true });
          const outputDir =
            typeof params.outputDir === "string" && params.outputDir.trim()
              ? params.outputDir.trim()
              : path.dirname(archivePath);
          const result = await extractZip(archivePath, outputDir);
          return jsonResult(result);
        }

        case "list_zip": {
          const archivePath = readStringParam(params, "path", { required: true });
          const result = await listZip(archivePath);
          const text = result.files
            .map((f) => `${f.dir ? "D" : "F"} ${f.size.toString().padStart(8)} ${f.path}`)
            .join("\n");
          return {
            content: [{ type: "text", text }],
            details: { fileCount: result.files.length, files: result.files },
          };
        }

        case "create_tar": {
          const paths = params.paths;
          if (!Array.isArray(paths) || paths.length === 0) {
            throw new Error("paths array required for create_tar");
          }
          const inputPaths = paths
            .filter((p): p is string => typeof p === "string")
            .map((p) => p.trim())
            .filter(Boolean);
          const compression =
            typeof params.compression === "string" && params.compression.trim()
              ? params.compression.trim()
              : "gz";
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : `archive-${Date.now()}${tarExtension(compression)}`;
          const result = await createTar(inputPaths, outputPath, compression);
          return jsonResult(result);
        }

        case "extract_tar": {
          const archivePath = readStringParam(params, "path", { required: true });
          const outputDir =
            typeof params.outputDir === "string" && params.outputDir.trim()
              ? params.outputDir.trim()
              : path.dirname(archivePath);
          const stripComponents =
            typeof params.stripComponents === "number" && Number.isFinite(params.stripComponents)
              ? Math.max(0, Math.trunc(params.stripComponents))
              : 0;
          const result = await extractTar(archivePath, outputDir, stripComponents);
          return jsonResult(result);
        }

        case "list_tar": {
          const archivePath = readStringParam(params, "path", { required: true });
          const result = await listTar(archivePath);
          return {
            content: [{ type: "text", text: result.entries.join("\n") }],
            details: { entryCount: result.entries.length },
          };
        }

        case "gzip": {
          const inputPath = readStringParam(params, "path", { required: true });
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : `${inputPath}.gz`;
          await pipeline(createReadStream(inputPath), createGzip(), createWriteStream(outputPath));
          const stat = await fs.stat(outputPath);
          return jsonResult({
            outputPath,
            sizeKb: Math.round(stat.size / 1024),
          });
        }

        case "gunzip": {
          const inputPath = readStringParam(params, "path", { required: true });
          const outputPath =
            typeof params.outputPath === "string" && params.outputPath.trim()
              ? params.outputPath.trim()
              : inputPath.replace(/\.gz$/, "");
          await pipeline(
            createReadStream(inputPath),
            createGunzip(),
            createWriteStream(outputPath),
          );
          const stat = await fs.stat(outputPath);
          return jsonResult({
            outputPath,
            sizeKb: Math.round(stat.size / 1024),
          });
        }

        default:
          throw new Error(`Unknown archive action: ${action}`);
      }
    },
  };
}
