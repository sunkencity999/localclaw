import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import type { SearchableSelectListTheme } from "../components/searchable-select-list.js";
import { createSyntaxTheme } from "./syntax-theme.js";

const palette = {
  text: "#CC99CC",
  dim: "#776677",
  accent: "#FF9900",
  accentSoft: "#FF9966",
  border: "#332233",
  userBg: "#1A0A00",
  userText: "#FFCC99",
  systemText: "#9977AA",
  toolPendingBg: "#0A0A1E",
  toolSuccessBg: "#0A1A0A",
  toolErrorBg: "#1A0A0A",
  toolTitle: "#FF9900",
  toolOutput: "#FFCC99",
  quote: "#99CCFF",
  quoteBorder: "#553355",
  code: "#FFCC66",
  codeBlock: "#0A0A14",
  codeBorder: "#332233",
  link: "#9999FF",
  error: "#CC0000",
  success: "#99FF66",
};

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

const syntaxTheme = createSyntaxTheme(fg(palette.code));

/**
 * Highlight code with syntax coloring.
 * Returns an array of lines with ANSI escape codes.
 */
function highlightCode(code: string, lang?: string): string[] {
  try {
    // Auto-detect can be slow for very large blocks; prefer explicit language when available.
    // Check if language is supported, fall back to auto-detect
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    const highlighted = highlight(code, {
      language,
      theme: syntaxTheme,
      ignoreIllegals: true,
    });
    return highlighted.split("\n");
  } catch {
    // If highlighting fails, return plain code
    return code.split("\n").map((line) => fg(palette.code)(line));
  }
}

export const theme = {
  fg: fg(palette.text),
  dim: fg(palette.dim),
  accent: fg(palette.accent),
  accentSoft: fg(palette.accentSoft),
  success: fg(palette.success),
  error: fg(palette.error),
  header: (text: string) => chalk.bold(fg(palette.accent)(text)),
  system: fg(palette.systemText),
  userBg: bg(palette.userBg),
  userText: fg(palette.userText),
  toolTitle: fg(palette.toolTitle),
  toolOutput: fg(palette.toolOutput),
  toolPendingBg: bg(palette.toolPendingBg),
  toolSuccessBg: bg(palette.toolSuccessBg),
  toolErrorBg: bg(palette.toolErrorBg),
  border: fg(palette.border),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(fg(palette.accent)(text)),
  link: (text) => fg(palette.link)(text),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => fg(palette.code)(text),
  codeBlock: (text) => fg(palette.code)(text),
  codeBlockBorder: (text) => fg(palette.codeBorder)(text),
  quote: (text) => fg(palette.quote)(text),
  quoteBorder: (text) => fg(palette.quoteBorder)(text),
  hr: (text) => fg(palette.border)(text),
  listBullet: (text) => fg(palette.accentSoft)(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  highlightCode,
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => fg(palette.accent)(text),
  selectedText: (text) => chalk.bold(fg(palette.accent)(text)),
  description: (text) => fg(palette.dim)(text),
  scrollInfo: (text) => fg(palette.dim)(text),
  noMatch: (text) => fg(palette.dim)(text),
};

export const filterableSelectListTheme = {
  ...selectListTheme,
  filterLabel: (text: string) => fg(palette.dim)(text),
};

export const settingsListTheme: SettingsListTheme = {
  label: (text, selected) =>
    selected ? chalk.bold(fg(palette.accent)(text)) : fg(palette.text)(text),
  value: (text, selected) => (selected ? fg(palette.accentSoft)(text) : fg(palette.dim)(text)),
  description: (text) => fg(palette.systemText)(text),
  cursor: fg(palette.accent)("→ "),
  hint: (text) => fg(palette.dim)(text),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => fg(palette.border)(text),
  selectList: selectListTheme,
};

export const searchableSelectListTheme: SearchableSelectListTheme = {
  selectedPrefix: (text) => fg(palette.accent)(text),
  selectedText: (text) => chalk.bold(fg(palette.accent)(text)),
  description: (text) => fg(palette.dim)(text),
  scrollInfo: (text) => fg(palette.dim)(text),
  noMatch: (text) => fg(palette.dim)(text),
  searchPrompt: (text) => fg(palette.accentSoft)(text),
  searchInput: (text) => fg(palette.text)(text),
  matchHighlight: (text) => chalk.bold(fg(palette.accent)(text)),
};
