/**
 * User preferences tracker — learns from interactions to build a
 * personalized profile. Stored as JSON in the workspace memory directory.
 *
 * Tracks:
 * - Active hours (when the user typically interacts)
 * - Message style (average length, question frequency)
 * - Tool usage patterns (which tools are requested most)
 * - Topic frequency (common themes in conversations)
 */

import fs from "node:fs/promises";
import path from "node:path";

export type UserPreferences = {
  version: 1;
  updatedAt: string;
  /** Hour-of-day histogram (0-23) for user message activity. */
  activeHours: Record<number, number>;
  /** Average message length in characters. */
  avgMessageLength: number;
  /** Total messages observed. */
  totalMessages: number;
  /** Percentage of messages that are questions. */
  questionRatio: number;
  /** Topic keywords and their frequency. */
  topicFrequency: Record<string, number>;
  /** Common tool/action keywords the user requests. */
  toolPreferences: Record<string, number>;
  /** Days of week activity (0=Sun, 6=Sat). */
  activeDays: Record<number, number>;
};

const EMPTY_PREFERENCES: UserPreferences = {
  version: 1,
  updatedAt: new Date().toISOString(),
  activeHours: {},
  avgMessageLength: 0,
  totalMessages: 0,
  questionRatio: 0,
  topicFrequency: {},
  toolPreferences: {},
  activeDays: {},
};

const TOOL_KEYWORDS = [
  "search",
  "read",
  "write",
  "edit",
  "create",
  "delete",
  "run",
  "execute",
  "list",
  "find",
  "grep",
  "git",
  "commit",
  "push",
  "test",
  "build",
  "deploy",
  "install",
  "debug",
  "fix",
  "analyze",
  "summarize",
  "explain",
  "translate",
  "generate",
  "schedule",
  "remind",
  "notify",
  "email",
  "browse",
  "download",
];

const TOPIC_KEYWORDS = [
  "code",
  "bug",
  "feature",
  "api",
  "database",
  "server",
  "client",
  "auth",
  "security",
  "config",
  "deploy",
  "test",
  "docs",
  "design",
  "review",
  "refactor",
  "performance",
  "error",
  "meeting",
  "calendar",
  "email",
  "task",
  "project",
  "team",
  "data",
  "model",
  "ai",
  "ml",
  "python",
  "typescript",
  "react",
  "node",
  "docker",
  "aws",
  "cloud",
  "network",
  "file",
  "image",
];

function extractKeywords(message: string, dictionary: string[]): string[] {
  const lower = message.toLowerCase();
  return dictionary.filter((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`, "i");
    return regex.test(lower);
  });
}

export async function loadPreferences(workspaceDir: string): Promise<UserPreferences> {
  const filePath = path.join(workspaceDir, "memory", "user-preferences.json");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as UserPreferences;
    if (parsed.version === 1) {
      return parsed;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return { ...EMPTY_PREFERENCES };
}

export async function savePreferences(workspaceDir: string, prefs: UserPreferences): Promise<void> {
  const dir = path.join(workspaceDir, "memory");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "user-preferences.json");
  prefs.updatedAt = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(prefs, null, 2), "utf-8");
}

/**
 * Update preferences based on a new user message.
 */
export function updatePreferencesFromMessage(
  prefs: UserPreferences,
  message: string,
  timestamp?: Date,
): UserPreferences {
  const now = timestamp ?? new Date();
  const hour = now.getHours();
  const day = now.getDay();

  // Update active hours
  prefs.activeHours[hour] = (prefs.activeHours[hour] ?? 0) + 1;
  prefs.activeDays[day] = (prefs.activeDays[day] ?? 0) + 1;

  // Update message stats
  const prevTotal = prefs.totalMessages;
  const prevAvg = prefs.avgMessageLength;
  prefs.totalMessages = prevTotal + 1;
  prefs.avgMessageLength = (prevAvg * prevTotal + message.length) / prefs.totalMessages;

  // Update question ratio
  const isQuestion = message.includes("?");
  const prevQuestionCount = Math.round(prefs.questionRatio * prevTotal);
  prefs.questionRatio = (prevQuestionCount + (isQuestion ? 1 : 0)) / prefs.totalMessages;

  // Extract and count tool keywords
  const tools = extractKeywords(message, TOOL_KEYWORDS);
  for (const tool of tools) {
    prefs.toolPreferences[tool] = (prefs.toolPreferences[tool] ?? 0) + 1;
  }

  // Extract and count topic keywords
  const topics = extractKeywords(message, TOPIC_KEYWORDS);
  for (const topic of topics) {
    prefs.topicFrequency[topic] = (prefs.topicFrequency[topic] ?? 0) + 1;
  }

  return prefs;
}

/**
 * Generate a human-readable summary of learned preferences.
 */
export function summarizePreferences(prefs: UserPreferences): string {
  if (prefs.totalMessages === 0) {
    return "No interaction data yet.";
  }

  const lines: string[] = [];
  lines.push(`Based on ${prefs.totalMessages} messages:`);

  // Most active hours
  const sortedHours = Object.entries(prefs.activeHours)
    .map(([h, c]) => ({ hour: Number(h), count: c }))
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 3);
  if (sortedHours.length > 0) {
    const hourStr = sortedHours.map((h) => `${h.hour}:00`).join(", ");
    lines.push(`- Most active hours: ${hourStr}`);
  }

  // Message style
  lines.push(`- Average message length: ${Math.round(prefs.avgMessageLength)} chars`);
  lines.push(`- Question frequency: ${Math.round(prefs.questionRatio * 100)}%`);

  // Top tools
  const sortedTools = Object.entries(prefs.toolPreferences)
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (sortedTools.length > 0) {
    const toolStr = sortedTools.map(([t]) => t).join(", ");
    lines.push(`- Preferred tools/actions: ${toolStr}`);
  }

  // Top topics
  const sortedTopics = Object.entries(prefs.topicFrequency)
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (sortedTopics.length > 0) {
    const topicStr = sortedTopics.map(([t]) => t).join(", ");
    lines.push(`- Common topics: ${topicStr}`);
  }

  return lines.join("\n");
}
