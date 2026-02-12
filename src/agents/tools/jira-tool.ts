import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { createJiraClient } from "../../integrations/jira.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const JIRA_ACTIONS = [
  "search",
  "get_issue",
  "create_issue",
  "add_comment",
  "transition_issue",
  "get_transitions",
] as const;

const JiraToolSchema = Type.Object({
  action: optionalStringEnum(JIRA_ACTIONS),
  jql: Type.Optional(
    Type.String({
      description: "JQL query for search (e.g. 'assignee = currentUser() AND status != Done')",
    }),
  ),
  issueKey: Type.Optional(Type.String({ description: "Issue key (e.g. PROJ-123)" })),
  project: Type.Optional(Type.String({ description: "Project key for creating issues" })),
  summary: Type.Optional(Type.String({ description: "Issue summary/title" })),
  description: Type.Optional(Type.String({ description: "Issue description" })),
  issueType: Type.Optional(Type.String({ description: "Issue type (default: Task)" })),
  assignee: Type.Optional(Type.String({ description: "Assignee account ID" })),
  priority: Type.Optional(Type.String({ description: "Priority name (e.g. High, Medium, Low)" })),
  labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to apply" })),
  comment: Type.Optional(Type.String({ description: "Comment text" })),
  transitionId: Type.Optional(
    Type.String({ description: "Transition ID (get from get_transitions)" }),
  ),
  maxResults: Type.Optional(Type.Number({ description: "Max results for search (default: 50)" })),
});

export function createJiraTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const jiraConfig = options?.config?.integrations?.jira;
  if (!jiraConfig?.enabled) {
    return null;
  }
  const client = createJiraClient(jiraConfig);
  if (!client) {
    return null;
  }

  return {
    label: "Jira",
    name: "jira",
    description: [
      "Jira integration for issue tracking and project management.",
      "Actions: search (JQL query), get_issue, create_issue, add_comment,",
      "transition_issue (change status), get_transitions (list available transitions).",
      "All requests go directly to the configured Jira instance.",
    ].join(" "),
    parameters: JiraToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim() ? params.action.trim() : "search";

      switch (action) {
        case "search": {
          const jql = readStringParam(params, "jql", { required: true });
          const maxResults =
            typeof params.maxResults === "number" && Number.isFinite(params.maxResults)
              ? Math.max(1, Math.min(100, Math.trunc(params.maxResults)))
              : undefined;
          const result = await client.searchIssues(jql, maxResults);
          const text =
            result.issues.length > 0
              ? result.issues
                  .map(
                    (i) =>
                      `${i.key}: ${i.summary} [${i.status}]${i.assignee ? ` (${i.assignee})` : ""}`,
                  )
                  .join("\n")
              : "No issues found.";
          return {
            content: [{ type: "text", text }],
            details: result,
          };
        }

        case "get_issue": {
          const issueKey = readStringParam(params, "issueKey", { required: true });
          const issue = await client.getIssue(issueKey);
          const text = [
            `${issue.key}: ${issue.summary}`,
            `Status: ${issue.status}`,
            issue.assignee ? `Assignee: ${issue.assignee}` : null,
            issue.priority ? `Priority: ${issue.priority}` : null,
            issue.issueType ? `Type: ${issue.issueType}` : null,
          ]
            .filter(Boolean)
            .join("\n");
          return {
            content: [{ type: "text", text }],
            details: issue,
          };
        }

        case "create_issue": {
          const summary = readStringParam(params, "summary", { required: true });
          const project = readStringParam(params, "project");
          const description = readStringParam(params, "description");
          const issueType = readStringParam(params, "issueType");
          const assignee = readStringParam(params, "assignee");
          const priority = readStringParam(params, "priority");
          const labels = Array.isArray(params.labels)
            ? params.labels.filter((l): l is string => typeof l === "string")
            : undefined;
          const result = await client.createIssue({
            project: project ?? "",
            summary,
            description,
            issueType,
            assignee,
            priority,
            labels,
          });
          return {
            content: [{ type: "text", text: `Created issue ${result.key}` }],
            details: result,
          };
        }

        case "add_comment": {
          const issueKey = readStringParam(params, "issueKey", { required: true });
          const comment = readStringParam(params, "comment", { required: true });
          const result = await client.addComment(issueKey, comment);
          return {
            content: [{ type: "text", text: `Comment added to ${issueKey}` }],
            details: result,
          };
        }

        case "transition_issue": {
          const issueKey = readStringParam(params, "issueKey", { required: true });
          const transitionId = readStringParam(params, "transitionId", { required: true });
          const comment = readStringParam(params, "comment");
          await client.transitionIssue({ issueKey, transitionId, comment });
          return {
            content: [{ type: "text", text: `Transitioned ${issueKey}` }],
            details: { issueKey, transitionId },
          };
        }

        case "get_transitions": {
          const issueKey = readStringParam(params, "issueKey", { required: true });
          const transitions = await client.getTransitions(issueKey);
          const text =
            transitions.length > 0
              ? transitions.map((t) => `${t.id}: ${t.name} → ${t.to.name}`).join("\n")
              : "No transitions available.";
          return {
            content: [{ type: "text", text }],
            details: { issueKey, transitions },
          };
        }

        default:
          throw new Error(`Unknown jira action: ${action}`);
      }
    },
  };
}
