import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { createConfluenceClient } from "../../integrations/confluence.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const CONFLUENCE_ACTIONS = [
  "search",
  "get_page",
  "get_page_body",
  "create_page",
  "update_page",
  "list_spaces",
] as const;

const ConfluenceToolSchema = Type.Object({
  action: optionalStringEnum(CONFLUENCE_ACTIONS),
  cql: Type.Optional(
    Type.String({
      description: "CQL query for search (e.g. 'space = TEAM AND text ~ deployment')",
    }),
  ),
  pageId: Type.Optional(Type.String({ description: "Page ID for get/update operations" })),
  spaceKey: Type.Optional(Type.String({ description: "Space key for creating pages" })),
  title: Type.Optional(Type.String({ description: "Page title" })),
  body: Type.Optional(Type.String({ description: "Page body content (HTML storage format)" })),
  parentId: Type.Optional(Type.String({ description: "Parent page ID for nesting" })),
  version: Type.Optional(
    Type.Number({ description: "Current page version (required for update)" }),
  ),
  maxResults: Type.Optional(Type.Number({ description: "Max results for search (default: 25)" })),
});

export function createConfluenceTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const confluenceConfig = options?.config?.integrations?.confluence;
  if (!confluenceConfig?.enabled) {
    return null;
  }
  const client = createConfluenceClient(confluenceConfig);
  if (!client) {
    return null;
  }

  return {
    label: "Confluence",
    name: "confluence",
    description: [
      "Confluence integration for wiki and documentation management.",
      "Actions: search (CQL query), get_page (metadata), get_page_body (full content),",
      "create_page, update_page, list_spaces.",
      "All requests go directly to the configured Confluence instance.",
    ].join(" "),
    parameters: ConfluenceToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim() ? params.action.trim() : "search";

      switch (action) {
        case "search": {
          const cql = readStringParam(params, "cql", { required: true });
          const maxResults =
            typeof params.maxResults === "number" && Number.isFinite(params.maxResults)
              ? Math.max(1, Math.min(100, Math.trunc(params.maxResults)))
              : undefined;
          const result = await client.searchContent(cql, maxResults);
          const text =
            result.pages.length > 0
              ? result.pages
                  .map(
                    (p) => `${p.id}: ${p.title} [${p.spaceKey}]${p.webUrl ? ` ${p.webUrl}` : ""}`,
                  )
                  .join("\n")
              : "No pages found.";
          return {
            content: [{ type: "text", text }],
            details: result,
          };
        }

        case "get_page": {
          const pageId = readStringParam(params, "pageId", { required: true });
          const page = await client.getPage(pageId);
          const text = [
            `${page.title} (${page.id})`,
            `Space: ${page.spaceKey}`,
            `Status: ${page.status}`,
            `Version: ${page.version}`,
            page.webUrl ? `URL: ${page.webUrl}` : null,
          ]
            .filter(Boolean)
            .join("\n");
          return {
            content: [{ type: "text", text }],
            details: page,
          };
        }

        case "get_page_body": {
          const pageId = readStringParam(params, "pageId", { required: true });
          const body = await client.getPageBody(pageId);
          const truncated =
            body.length > 10000
              ? `${body.slice(0, 10000)}\n... [truncated, ${body.length} chars total]`
              : body;
          return {
            content: [{ type: "text", text: truncated || "(empty page)" }],
            details: { pageId, length: body.length },
          };
        }

        case "create_page": {
          const title = readStringParam(params, "title", { required: true });
          const body = readStringParam(params, "body", { required: true });
          const spaceKey = readStringParam(params, "spaceKey");
          const parentId = readStringParam(params, "parentId");
          const result = await client.createPage({
            spaceKey: spaceKey ?? "",
            title,
            body,
            parentId,
          });
          return {
            content: [{ type: "text", text: `Created page "${result.title}" (${result.id})` }],
            details: result,
          };
        }

        case "update_page": {
          const pageId = readStringParam(params, "pageId", { required: true });
          const title = readStringParam(params, "title", { required: true });
          const body = readStringParam(params, "body", { required: true });
          const version =
            typeof params.version === "number" && Number.isFinite(params.version)
              ? Math.trunc(params.version)
              : undefined;
          if (version === undefined) {
            throw new Error(
              "version is required for update (get current version from get_page first)",
            );
          }
          const result = await client.updatePage({ pageId, title, body, version });
          return {
            content: [{ type: "text", text: `Updated page "${result.title}" (${result.id})` }],
            details: result,
          };
        }

        case "list_spaces": {
          const spaces = await client.getSpaces();
          const text =
            spaces.length > 0
              ? spaces.map((s) => `${s.key}: ${s.name} (${s.type})`).join("\n")
              : "No spaces found.";
          return {
            content: [{ type: "text", text }],
            details: { spaces },
          };
        }

        default:
          throw new Error(`Unknown confluence action: ${action}`);
      }
    },
  };
}
