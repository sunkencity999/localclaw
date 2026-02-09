/**
 * Workflow automation hook — loads workflow YAML files on gateway startup
 * and registers event-driven workflows as internal hooks.
 *
 * Scheduled workflows are registered as cron jobs via the cron service.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { InternalHookEvent, InternalHookHandler } from "../hooks/internal-hooks.js";
import type { WorkflowDefinition } from "./types.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { runWorkflow } from "./executor.js";
import { loadWorkflowFiles } from "./loader.js";

/**
 * Create a hook handler for an event-triggered workflow.
 */
function createWorkflowHookHandler(
  workflow: WorkflowDefinition,
  workspaceDir: string,
): InternalHookHandler {
  return async (event: InternalHookEvent) => {
    const sessionKey = event.sessionKey || "agent:main:main";
    const result = await runWorkflow(workflow, {
      workspaceDir,
      sessionKey,
    });

    if (result.status === "ok") {
      console.log(
        `[workflows] ✓ "${workflow.name}" completed (${result.stepsRun}/${result.stepsTotal} steps, ${result.durationMs}ms)`,
      );
    } else {
      console.error(
        `[workflows] ✗ "${workflow.name}" failed at step ${result.stepsRun + 1}: ${result.error}`,
      );
    }
  };
}

/**
 * Load and register all workspace workflows.
 * Called on gateway startup.
 */
export async function loadAndRegisterWorkflows(cfg: OpenClawConfig): Promise<number> {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const workflows = await loadWorkflowFiles(workspaceDir);

  let registered = 0;

  for (const workflow of workflows) {
    if (workflow.trigger.kind === "event") {
      const handler = createWorkflowHookHandler(workflow, workspaceDir);
      registerInternalHook(workflow.trigger.event, handler);
      registered++;
      console.log(`[workflows] Registered workflow "${workflow.name}" → ${workflow.trigger.event}`);
    } else if (workflow.trigger.kind === "schedule") {
      // Scheduled workflows would integrate with the cron service.
      // For now, log that they were found but need cron integration.
      console.log(
        `[workflows] Found scheduled workflow "${workflow.name}" (${workflow.trigger.expr}) — use 'openclaw cron add' to register`,
      );
    }
  }

  return registered;
}
