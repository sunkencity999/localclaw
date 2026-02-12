import type { z } from "zod";
import type { JiraIntegrationSchema } from "../config/zod-schema.integrations.js";

export type JiraConfig = z.infer<typeof JiraIntegrationSchema>;

export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  assignee?: string | null;
  description?: string | null;
  priority?: string | null;
  issueType?: string | null;
  created?: string | null;
  updated?: string | null;
};

export type JiraSearchResult = {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
};

export type JiraCreateIssueParams = {
  project: string;
  summary: string;
  description?: string;
  issueType?: string;
  assignee?: string;
  priority?: string;
  labels?: string[];
};

export type JiraTransitionParams = {
  issueKey: string;
  transitionId: string;
  comment?: string;
};

export class JiraClient {
  private baseUrl: string;
  private email: string;
  private apiToken: string;
  private defaultProject: string | undefined;
  private timeoutMs: number;
  private maxResults: number;

  constructor(config: NonNullable<JiraConfig>) {
    if (!config.baseUrl) {
      throw new Error("Jira baseUrl is required");
    }
    if (!config.email) {
      throw new Error("Jira email is required");
    }
    if (!config.apiToken) {
      throw new Error("Jira apiToken is required");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.email = config.email;
    this.apiToken = config.apiToken;
    this.defaultProject = config.defaultProject;
    this.timeoutMs = (config.timeoutSeconds ?? 30) * 1000;
    this.maxResults = config.maxResults ?? 50;
  }

  private get headers(): Record<string, string> {
    const credentials = Buffer.from(`${this.email}:${this.apiToken}`).toString("base64");
    return {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3${path}`;
    const response = await fetch(url, {
      ...options,
      headers: { ...this.headers, ...options?.headers },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Jira API error ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  async searchIssues(jql: string, maxResults?: number): Promise<JiraSearchResult> {
    const limit = maxResults ?? this.maxResults;
    const result = await this.request<{
      issues: Array<{
        key: string;
        fields: {
          summary: string;
          status: { name: string };
          assignee?: { displayName: string } | null;
          description?: unknown;
          priority?: { name: string } | null;
          issuetype?: { name: string } | null;
          created?: string;
          updated?: string;
        };
      }>;
      total: number;
      startAt: number;
      maxResults: number;
    }>(`/search?jql=${encodeURIComponent(jql)}&maxResults=${limit}`);

    return {
      issues: result.issues.map((issue) => ({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        assignee: issue.fields.assignee?.displayName ?? null,
        description: issue.fields.description ? JSON.stringify(issue.fields.description) : null,
        priority: issue.fields.priority?.name ?? null,
        issueType: issue.fields.issuetype?.name ?? null,
        created: issue.fields.created ?? null,
        updated: issue.fields.updated ?? null,
      })),
      total: result.total,
      startAt: result.startAt,
      maxResults: result.maxResults,
    };
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    const result = await this.request<{
      key: string;
      fields: {
        summary: string;
        status: { name: string };
        assignee?: { displayName: string } | null;
        description?: unknown;
        priority?: { name: string } | null;
        issuetype?: { name: string } | null;
        created?: string;
        updated?: string;
      };
    }>(`/issue/${encodeURIComponent(issueKey)}`);

    return {
      key: result.key,
      summary: result.fields.summary,
      status: result.fields.status.name,
      assignee: result.fields.assignee?.displayName ?? null,
      description: result.fields.description ? JSON.stringify(result.fields.description) : null,
      priority: result.fields.priority?.name ?? null,
      issueType: result.fields.issuetype?.name ?? null,
      created: result.fields.created ?? null,
      updated: result.fields.updated ?? null,
    };
  }

  async createIssue(params: JiraCreateIssueParams): Promise<{ key: string; id: string }> {
    const project = params.project || this.defaultProject;
    if (!project) {
      throw new Error("Project key is required (set defaultProject in config or pass explicitly)");
    }
    const body: Record<string, unknown> = {
      fields: {
        project: { key: project },
        summary: params.summary,
        issuetype: { name: params.issueType ?? "Task" },
        ...(params.description
          ? {
              description: {
                type: "doc",
                version: 1,
                content: [
                  { type: "paragraph", content: [{ type: "text", text: params.description }] },
                ],
              },
            }
          : {}),
        ...(params.assignee ? { assignee: { accountId: params.assignee } } : {}),
        ...(params.priority ? { priority: { name: params.priority } } : {}),
        ...(params.labels ? { labels: params.labels } : {}),
      },
    };
    return this.request<{ key: string; id: string }>("/issue", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async addComment(issueKey: string, comment: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
        },
      }),
    });
  }

  async transitionIssue(params: JiraTransitionParams): Promise<void> {
    const body: Record<string, unknown> = {
      transition: { id: params.transitionId },
    };
    if (params.comment) {
      body.update = {
        comment: [
          {
            add: {
              body: {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: params.comment }] }],
              },
            },
          },
        ],
      };
    }
    await this.request(`/issue/${encodeURIComponent(params.issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getTransitions(
    issueKey: string,
  ): Promise<Array<{ id: string; name: string; to: { name: string } }>> {
    const result = await this.request<{
      transitions: Array<{ id: string; name: string; to: { name: string } }>;
    }>(`/issue/${encodeURIComponent(issueKey)}/transitions`);
    return result.transitions;
  }
}

export function createJiraClient(config: JiraConfig): JiraClient | null {
  if (!config?.enabled) {
    return null;
  }
  return new JiraClient(config);
}
