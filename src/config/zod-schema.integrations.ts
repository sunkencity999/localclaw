import { z } from "zod";

export const JiraIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().optional(),
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
    appToken: z.string().optional(),
    signingSecret: z.string().optional(),
    defaultChannel: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const IntegrationsSchema = z
  .object({
    jira: JiraIntegrationSchema,
    confluence: ConfluenceIntegrationSchema,
    slack: SlackIntegrationSchema,
  })
  .strict()
  .optional();
