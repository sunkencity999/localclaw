import type { z } from "zod";
import type { ConfluenceIntegrationSchema } from "../config/zod-schema.integrations.js";

export type ConfluenceConfig = z.infer<typeof ConfluenceIntegrationSchema>;

export type ConfluencePage = {
  id: string;
  title: string;
  spaceKey: string;
  status: string;
  version: number;
  bodyExcerpt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  webUrl?: string | null;
};

export type ConfluenceSearchResult = {
  pages: ConfluencePage[];
  total: number;
  start: number;
  limit: number;
};

export type ConfluenceCreatePageParams = {
  spaceKey: string;
  title: string;
  body: string;
  parentId?: string;
  status?: "current" | "draft";
};

export type ConfluenceUpdatePageParams = {
  pageId: string;
  title: string;
  body: string;
  version: number;
  status?: "current" | "draft";
};

export class ConfluenceClient {
  private baseUrl: string;
  private email: string;
  private apiToken: string;
  private defaultSpace: string | undefined;
  private timeoutMs: number;
  private maxResults: number;

  constructor(config: NonNullable<ConfluenceConfig>) {
    if (!config.baseUrl) {
      throw new Error("Confluence baseUrl is required");
    }
    if (!config.email) {
      throw new Error("Confluence email is required");
    }
    if (!config.apiToken) {
      throw new Error("Confluence apiToken is required");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.email = config.email;
    this.apiToken = config.apiToken;
    this.defaultSpace = config.defaultSpace;
    this.timeoutMs = (config.timeoutSeconds ?? 30) * 1000;
    this.maxResults = config.maxResults ?? 25;
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
    const url = `${this.baseUrl}/wiki/rest/api${path}`;
    const response = await fetch(url, {
      ...options,
      headers: { ...this.headers, ...options?.headers },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Confluence API error ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  async searchContent(cql: string, limit?: number): Promise<ConfluenceSearchResult> {
    const max = limit ?? this.maxResults;
    const result = await this.request<{
      results: Array<{
        id: string;
        title: string;
        status: string;
        space?: { key: string };
        version?: { number: number };
        body?: { view?: { value: string } };
        _links?: { webui?: string };
        history?: { createdDate?: string };
      }>;
      totalSize: number;
      start: number;
      limit: number;
    }>(`/content/search?cql=${encodeURIComponent(cql)}&limit=${max}`);

    return {
      pages: result.results.map((page) => ({
        id: page.id,
        title: page.title,
        spaceKey: page.space?.key ?? "",
        status: page.status,
        version: page.version?.number ?? 1,
        bodyExcerpt: page.body?.view?.value?.slice(0, 500) ?? null,
        webUrl: page._links?.webui ? `${this.baseUrl}/wiki${page._links.webui}` : null,
        createdAt: page.history?.createdDate ?? null,
        updatedAt: null,
      })),
      total: result.totalSize,
      start: result.start,
      limit: result.limit,
    };
  }

  async getPage(pageId: string): Promise<ConfluencePage> {
    const result = await this.request<{
      id: string;
      title: string;
      status: string;
      space: { key: string };
      version: { number: number; when: string };
      body?: { storage?: { value: string } };
      _links?: { webui?: string };
      history?: { createdDate?: string };
    }>(`/content/${encodeURIComponent(pageId)}?expand=body.storage,version,space,history`);

    return {
      id: result.id,
      title: result.title,
      spaceKey: result.space.key,
      status: result.status,
      version: result.version.number,
      bodyExcerpt: result.body?.storage?.value?.slice(0, 2000) ?? null,
      webUrl: result._links?.webui ? `${this.baseUrl}/wiki${result._links.webui}` : null,
      createdAt: result.history?.createdDate ?? null,
      updatedAt: result.version.when ?? null,
    };
  }

  async getPageBody(pageId: string): Promise<string> {
    const result = await this.request<{
      body?: { storage?: { value: string } };
    }>(`/content/${encodeURIComponent(pageId)}?expand=body.storage`);
    return result.body?.storage?.value ?? "";
  }

  async createPage(params: ConfluenceCreatePageParams): Promise<{ id: string; title: string }> {
    const spaceKey = params.spaceKey || this.defaultSpace;
    if (!spaceKey) {
      throw new Error("Space key is required (set defaultSpace in config or pass explicitly)");
    }
    const body = {
      type: "page",
      title: params.title,
      space: { key: spaceKey },
      status: params.status ?? "current",
      body: {
        storage: {
          value: params.body,
          representation: "storage",
        },
      },
      ...(params.parentId ? { ancestors: [{ id: params.parentId }] } : {}),
    };
    return this.request<{ id: string; title: string }>("/content", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updatePage(params: ConfluenceUpdatePageParams): Promise<{ id: string; title: string }> {
    const body = {
      type: "page",
      title: params.title,
      status: params.status ?? "current",
      version: { number: params.version + 1 },
      body: {
        storage: {
          value: params.body,
          representation: "storage",
        },
      },
    };
    return this.request<{ id: string; title: string }>(
      `/content/${encodeURIComponent(params.pageId)}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
  }

  async getSpaces(): Promise<Array<{ key: string; name: string; type: string }>> {
    const result = await this.request<{
      results: Array<{ key: string; name: string; type: string }>;
    }>(`/space?limit=${this.maxResults}`);
    return result.results;
  }
}

export function createConfluenceClient(config: ConfluenceConfig): ConfluenceClient | null {
  if (!config?.enabled) {
    return null;
  }
  return new ConfluenceClient(config);
}
