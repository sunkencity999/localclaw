/**
 * Workflow loader — reads YAML workflow files from the workspace.
 */

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { WorkflowDefinition, WorkflowTrigger, WorkflowStep } from "./types.js";

function parseTrigger(raw: Record<string, unknown>): WorkflowTrigger | null {
  if (typeof raw.event === "string" && raw.event.trim()) {
    return { kind: "event", event: raw.event.trim() };
  }
  if (typeof raw.schedule === "string" && raw.schedule.trim()) {
    return {
      kind: "schedule",
      expr: raw.schedule.trim(),
      tz: typeof raw.tz === "string" ? raw.tz.trim() : undefined,
    };
  }
  return null;
}

function parseStep(raw: Record<string, unknown>): WorkflowStep | null {
  const action = typeof raw.action === "string" ? raw.action.trim() : "";

  if (action === "agent-turn") {
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    if (!message) {
      return null;
    }
    return {
      action: "agent-turn",
      message,
      model: typeof raw.model === "string" ? raw.model.trim() : undefined,
      thinking: typeof raw.thinking === "string" ? raw.thinking.trim() : undefined,
      timeoutSeconds: typeof raw.timeoutSeconds === "number" ? raw.timeoutSeconds : undefined,
    };
  }

  if (action === "notify") {
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    if (!message) {
      return null;
    }
    return {
      action: "notify",
      message,
      channel: typeof raw.channel === "string" ? raw.channel.trim() : undefined,
    };
  }

  if (action === "write-file") {
    const filePath = typeof raw.path === "string" ? raw.path.trim() : "";
    const content = typeof raw.content === "string" ? raw.content : "";
    if (!filePath) {
      return null;
    }
    return {
      action: "write-file",
      path: filePath,
      content,
      append: raw.append === true,
    };
  }

  return null;
}

function parseWorkflow(raw: Record<string, unknown>, filename: string): WorkflowDefinition | null {
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : filename.replace(/\.(ya?ml)$/i, "");

  const trigger =
    raw.trigger && typeof raw.trigger === "object"
      ? parseTrigger(raw.trigger as Record<string, unknown>)
      : null;
  if (!trigger) {
    return null;
  }

  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  const steps: WorkflowStep[] = [];
  for (const rawStep of rawSteps) {
    if (rawStep && typeof rawStep === "object") {
      const step = parseStep(rawStep as Record<string, unknown>);
      if (step) {
        steps.push(step);
      }
    }
  }

  if (steps.length === 0) {
    return null;
  }

  return {
    name,
    description: typeof raw.description === "string" ? raw.description.trim() : undefined,
    enabled: raw.enabled !== false,
    trigger,
    steps,
  };
}

export async function loadWorkflowFiles(workspaceDir: string): Promise<WorkflowDefinition[]> {
  const workflowsDir = path.join(workspaceDir, "workflows");
  const workflows: WorkflowDefinition[] = [];

  try {
    const entries = await fs.readdir(workflowsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!/\.(ya?ml)$/i.test(entry.name)) {
        continue;
      }
      try {
        const content = await fs.readFile(path.join(workflowsDir, entry.name), "utf-8");
        const parsed = YAML.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        const workflow = parseWorkflow(parsed as Record<string, unknown>, entry.name);
        if (workflow && workflow.enabled) {
          workflows.push(workflow);
        }
      } catch (err) {
        console.warn(
          `[workflows] Failed to parse ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch {
    // workflows/ directory doesn't exist — that's fine
  }

  return workflows;
}
