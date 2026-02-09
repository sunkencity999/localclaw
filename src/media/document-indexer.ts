/**
 * Document indexer — extracts and indexes text from documents in the workspace.
 *
 * Watches `<workspace>/documents/` for PDF, markdown, and text files,
 * extracts their content, and stores indexed summaries in
 * `<workspace>/memory/document-index.json` for agent context.
 */

import fs from "node:fs/promises";
import path from "node:path";

export type IndexedDocument = {
  filename: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string;
  indexedAt: string;
  /** First 500 chars for quick preview. */
  preview: string;
};

export type DocumentIndex = {
  version: 1;
  updatedAt: string;
  documents: IndexedDocument[];
};

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".log": "text/plain",
  ".sh": "text/x-shellscript",
  ".py": "text/x-python",
  ".ts": "text/typescript",
  ".js": "text/javascript",
};

const MAX_EXTRACT_CHARS = 50_000;
const MAX_PREVIEW_CHARS = 500;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function isSupportedFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext in SUPPORTED_EXTENSIONS;
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS[ext] ?? "application/octet-stream";
}

async function extractTextFromFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8");
  return content.slice(0, MAX_EXTRACT_CHARS);
}

export async function indexDocumentsDir(workspaceDir: string): Promise<DocumentIndex> {
  const documentsDir = path.join(workspaceDir, "documents");
  const index: DocumentIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    documents: [],
  };

  try {
    const entries = await fs.readdir(documentsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!isSupportedFile(entry.name)) {
        continue;
      }

      const filePath = path.join(documentsDir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) {
          continue;
        }

        const extractedText = await extractTextFromFile(filePath);
        const preview = extractedText.slice(0, MAX_PREVIEW_CHARS).trim();

        index.documents.push({
          filename: entry.name,
          path: filePath,
          mimeType: getMimeType(entry.name),
          sizeBytes: stat.size,
          extractedText,
          indexedAt: new Date().toISOString(),
          preview,
        });
      } catch {
        // Skip files that can't be read
      }
    }
  } catch {
    // documents/ directory doesn't exist — that's fine
  }

  return index;
}

export async function saveDocumentIndex(workspaceDir: string, index: DocumentIndex): Promise<void> {
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const indexPath = path.join(memoryDir, "document-index.json");

  // Save without the full extracted text (just previews) to keep the file small
  const compactIndex = {
    ...index,
    documents: index.documents.map((doc) => ({
      filename: doc.filename,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      indexedAt: doc.indexedAt,
      preview: doc.preview,
    })),
  };

  await fs.writeFile(indexPath, JSON.stringify(compactIndex, null, 2), "utf-8");
}

export async function loadDocumentIndex(workspaceDir: string): Promise<DocumentIndex | null> {
  const indexPath = path.join(workspaceDir, "memory", "document-index.json");
  try {
    const content = await fs.readFile(indexPath, "utf-8");
    return JSON.parse(content) as DocumentIndex;
  } catch {
    return null;
  }
}
