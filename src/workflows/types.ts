/**
 * Workflow definition types.
 *
 * Workflows are declarative YAML files that define event→action pipelines.
 * They live in `<workspace>/workflows/` and are loaded on gateway startup.
 */

export type WorkflowTrigger =
  | { kind: "event"; event: string }
  | { kind: "schedule"; expr: string; tz?: string };

export type WorkflowStepAgentTurn = {
  action: "agent-turn";
  message: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

export type WorkflowStepNotify = {
  action: "notify";
  message: string;
  channel?: string;
};

export type WorkflowStepWriteFile = {
  action: "write-file";
  path: string;
  content: string;
  append?: boolean;
};

export type WorkflowStep = WorkflowStepAgentTurn | WorkflowStepNotify | WorkflowStepWriteFile;

export type WorkflowDefinition = {
  name: string;
  description?: string;
  enabled?: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
};

export type WorkflowRunResult = {
  workflow: string;
  trigger: string;
  stepsRun: number;
  stepsTotal: number;
  status: "ok" | "error";
  error?: string;
  durationMs: number;
};
