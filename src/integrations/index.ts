export { JiraClient, createJiraClient } from "./jira.js";
export type { JiraConfig, JiraIssue, JiraSearchResult, JiraCreateIssueParams } from "./jira.js";

export { ConfluenceClient, createConfluenceClient } from "./confluence.js";
export type {
  ConfluenceConfig,
  ConfluencePage,
  ConfluenceSearchResult,
  ConfluenceCreatePageParams,
  ConfluenceUpdatePageParams,
} from "./confluence.js";

export { SlackClient, createSlackClient } from "./slack.js";
export type {
  SlackConfig,
  SlackMessage,
  SlackChannel,
  SlackUser,
  SlackPostMessageParams,
  SlackSearchParams,
} from "./slack.js";

export type { IntegrationsConfig } from "./types.js";
