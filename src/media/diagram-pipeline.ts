/**
 * Diagram pipeline — detects Mermaid code blocks in agent output
 * and renders them to SVG files in the workspace media directory.
 *
 * Falls back to saving raw .mmd files if rendering tools are unavailable.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";

export type DiagramResult = {
  format: "svg" | "mmd";
  path: string;
  source: string;
};

const MERMAID_FENCE_RE = /```mermaid\n([\s\S]*?)```/g;

/**
 * Extract Mermaid diagram blocks from text.
 */
export function extractMermaidBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(MERMAID_FENCE_RE)) {
    const content = match[1]?.trim();
    if (content) {
      blocks.push(content);
    }
  }
  return blocks;
}

/**
 * Check if mmdc (mermaid-cli) is available.
 */
async function isMmdcAvailable(): Promise<boolean> {
  try {
    const result = await runCommandWithTimeout(["mmdc", "--version"], {
      timeoutMs: 3000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Render a Mermaid diagram to SVG using mmdc.
 */
async function renderWithMmdc(source: string, outputPath: string): Promise<boolean> {
  const inputPath = `${outputPath}.mmd`;
  try {
    await fs.writeFile(inputPath, source, "utf-8");
    const result = await runCommandWithTimeout(
      ["mmdc", "-i", inputPath, "-o", outputPath, "-b", "transparent"],
      { timeoutMs: 15000 },
    );
    return result.code === 0;
  } catch {
    return false;
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
  }
}

/**
 * Process Mermaid blocks from text and render them to files.
 * Returns the paths to the generated diagram files.
 */
export async function processDiagrams(text: string, outputDir: string): Promise<DiagramResult[]> {
  const blocks = extractMermaidBlocks(text);
  if (blocks.length === 0) {
    return [];
  }

  await fs.mkdir(outputDir, { recursive: true });
  const canRender = await isMmdcAvailable();
  const results: DiagramResult[] = [];

  for (const source of blocks) {
    const id = crypto.randomUUID().slice(0, 8);
    const baseName = `diagram-${id}`;

    if (canRender) {
      const svgPath = path.join(outputDir, `${baseName}.svg`);
      const rendered = await renderWithMmdc(source, svgPath);
      if (rendered) {
        results.push({ format: "svg", path: svgPath, source });
        continue;
      }
    }

    // Fallback: save as .mmd file
    const mmdPath = path.join(outputDir, `${baseName}.mmd`);
    await fs.writeFile(mmdPath, source, "utf-8");
    results.push({ format: "mmd", path: mmdPath, source });
  }

  return results;
}

/**
 * Replace Mermaid code blocks in text with references to rendered files.
 */
export function replaceMermaidWithRefs(text: string, results: DiagramResult[]): string {
  let resultIdx = 0;
  return text.replace(MERMAID_FENCE_RE, (match) => {
    const result = results[resultIdx];
    resultIdx++;
    if (!result) {
      return match;
    }
    const relPath = path.basename(result.path);
    if (result.format === "svg") {
      return `![Diagram](${relPath})`;
    }
    return `[Diagram source: ${relPath}]`;
  });
}
