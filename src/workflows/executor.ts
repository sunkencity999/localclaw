/**
 * Workflow executor — runs workflow steps sequentially.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
  WorkflowStepWriteFile,
} from "./types.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";

export type WorkflowExecContext = {
  workspaceDir: string;
  sessionKey: string;
};

async function executeAgentTurn(
  step: Extract<WorkflowStep, { action: "agent-turn" }>,
  ctx: WorkflowExecContext,
): Promise<void> {
  // Inject the message as a system event so the next heartbeat picks it up.
  enqueueSystemEvent(`[Workflow] ${step.message}`, { sessionKey: ctx.sessionKey });
  requestHeartbeatNow({ reason: "workflow" });
}

async function executeNotify(
  step: Extract<WorkflowStep, { action: "notify" }>,
  ctx: WorkflowExecContext,
): Promise<void> {
  enqueueSystemEvent(`[Workflow notification] ${step.message}`, {
    sessionKey: ctx.sessionKey,
  });
  requestHeartbeatNow({ reason: "workflow-notify" });
}

async function executeWriteFile(
  step: WorkflowStepWriteFile,
  ctx: WorkflowExecContext,
): Promise<void> {
  // Resolve path relative to workspace
  const filePath = path.isAbsolute(step.path) ? step.path : path.join(ctx.workspaceDir, step.path);

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (step.append) {
    await fs.appendFile(filePath, step.content, "utf-8");
  } else {
    await fs.writeFile(filePath, step.content, "utf-8");
  }
}

async function executeStep(step: WorkflowStep, ctx: WorkflowExecContext): Promise<void> {
  switch (step.action) {
    case "agent-turn":
      await executeAgentTurn(step, ctx);
      break;
    case "notify":
      await executeNotify(step, ctx);
      break;
    case "write-file":
      await executeWriteFile(step, ctx);
      break;
  }
}

export async function runWorkflow(
  workflow: WorkflowDefinition,
  ctx: WorkflowExecContext,
): Promise<WorkflowRunResult> {
  const startedAt = Date.now();
  let stepsRun = 0;

  try {
    for (const step of workflow.steps) {
      await executeStep(step, ctx);
      stepsRun++;
    }

    return {
      workflow: workflow.name,
      trigger: workflow.trigger.kind === "event" ? workflow.trigger.event : workflow.trigger.expr,
      stepsRun,
      stepsTotal: workflow.steps.length,
      status: "ok",
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      workflow: workflow.name,
      trigger: workflow.trigger.kind === "event" ? workflow.trigger.event : workflow.trigger.expr,
      stepsRun,
      stepsTotal: workflow.steps.length,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}
