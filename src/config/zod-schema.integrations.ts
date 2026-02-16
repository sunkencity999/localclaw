import { z } from "zod";

export const JiraIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().optional(),
    /** Auth type: "basic" (email + apiToken) or "pat" (Personal Access Token, Bearer). Default: "basic". */
    authType: z.enum(["basic", "pat"]).optional(),
    /** Jira REST API version: "2" for Server/Data Center, "3" for Cloud. Default: "2" for PAT, "3" for basic. */
    apiVersion: z.enum(["2", "3"]).optional(),
    email: z.string().optional(),
    apiToken: z.string().optional(),
    defaultProject: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const ConfluenceIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().optional(),
    email: z.string().optional(),
    apiToken: z.string().optional(),
    defaultSpace: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const SlackIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    botToken: z.string().optional(),
    /** User OAuth token (xoxp-...) for APIs that require user-level auth (e.g. search.messages). */
    userToken: z.string().optional(),
    appToken: z.string().optional(),
    signingSecret: z.string().optional(),
    defaultChannel: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const EmailAccountSchema = z.object({
  /** Gmail address (must be authenticated with gog) */
  address: z.string(),
  /** Human-friendly label for this account (e.g. "home", "work") */
  label: z.string().optional(),
  /** gog OAuth client name (for Workspace accounts using custom credentials) */
  client: z.string().optional(),
});

export const EmailIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** List of Gmail accounts (each must be authenticated via `gog auth login`) */
    accounts: z.array(EmailAccountSchema).optional(),
    /** Default account address to use when none is specified */
    defaultAccount: z.string().optional(),
    /** Command timeout in seconds (default: 30) */
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const IntegrationsSchema = z
  .object({
    jira: JiraIntegrationSchema,
    confluence: ConfluenceIntegrationSchema,
    slack: SlackIntegrationSchema,
    email: EmailIntegrationSchema,
  })
  .strict()
  .optional();
