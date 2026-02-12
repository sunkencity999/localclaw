import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { note } from "../terminal/note.js";

type IntegrationChoice = "jira" | "confluence" | "slack" | "__done";

export async function setupIntegrations(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const integrations = (cfg as Record<string, unknown>).integrations as
    | Record<string, unknown>
    | undefined;
  const jiraEnabled = (integrations?.jira as Record<string, unknown> | undefined)?.enabled === true;
  const confluenceEnabled =
    (integrations?.confluence as Record<string, unknown> | undefined)?.enabled === true;
  const slackEnabled =
    (integrations?.slack as Record<string, unknown> | undefined)?.enabled === true;

  note(
    [
      "Connect third-party services as agent tools.",
      "",
      `Jira:       ${jiraEnabled ? "enabled" : "not configured"}`,
      `Confluence: ${confluenceEnabled ? "enabled" : "not configured"}`,
      `Slack:      ${slackEnabled ? "enabled" : "not configured"}`,
    ].join("\n"),
    "Integrations",
  );

  let next = { ...cfg };

  while (true) {
    const choice = (await prompter.select({
      message: "Which integration to configure?",
      options: [
        { value: "jira" as const, label: "Jira", hint: "Issue tracking and project management" },
        { value: "confluence" as const, label: "Confluence", hint: "Wiki and documentation" },
        { value: "slack" as const, label: "Slack", hint: "Post messages and search channels" },
        { value: "__done" as const, label: "Done", hint: "Return to main menu" },
      ],
    })) as IntegrationChoice;

    if (choice === "__done") {
      break;
    }

    if (choice === "jira") {
      next = await setupJira(next, runtime, prompter);
    } else if (choice === "confluence") {
      next = await setupConfluence(next, runtime, prompter);
    } else if (choice === "slack") {
      next = await setupSlackIntegration(next, runtime, prompter);
    }
  }

  return next;
}

function getIntegrationsBlock(cfg: OpenClawConfig): Record<string, unknown> {
  return ((cfg as Record<string, unknown>).integrations as Record<string, unknown>) ?? {};
}

function setIntegrationsBlock(
  cfg: OpenClawConfig,
  integrations: Record<string, unknown>,
): OpenClawConfig {
  return { ...cfg, integrations } as OpenClawConfig;
}

async function setupJira(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const integrations = getIntegrationsBlock(cfg);
  const existing = (integrations.jira as Record<string, unknown>) ?? {};

  note(
    [
      "Jira integration lets the agent search issues, create tickets,",
      "add comments, and transition issue statuses.",
      "",
      "You'll need:",
      "  - Your Jira instance URL (e.g. https://yourteam.atlassian.net)",
      "  - An email address associated with your Atlassian account",
      "  - An API token (https://id.atlassian.com/manage-profile/security/api-tokens)",
    ].join("\n"),
    "Jira setup",
  );

  const enable = await prompter.confirm({
    message: "Enable Jira integration?",
    initialValue: existing.enabled === true,
  });

  if (!enable) {
    return setIntegrationsBlock(cfg, {
      ...integrations,
      jira: { ...existing, enabled: false },
    });
  }

  const baseUrl = String(
    await prompter.text({
      message: "Jira instance URL",
      initialValue: (existing.baseUrl as string) ?? "",
      placeholder: "https://yourteam.atlassian.net",
      validate: (v) =>
        String(v ?? "")
          .trim()
          .startsWith("http")
          ? undefined
          : "Must be a valid URL starting with http(s)://",
    }),
  ).trim();

  const email = String(
    await prompter.text({
      message: "Jira account email",
      initialValue: (existing.email as string) ?? "",
      placeholder: "you@example.com",
      validate: (v) =>
        String(v ?? "")
          .trim()
          .includes("@")
          ? undefined
          : "Must be a valid email address",
    }),
  ).trim();

  const hasToken = Boolean(existing.apiToken);
  const tokenInput = String(
    await prompter.text({
      message: hasToken ? "Jira API token (leave blank to keep current)" : "Jira API token",
      placeholder: hasToken ? "Leave blank to keep current" : "Paste your API token",
    }),
  ).trim();
  const apiToken = tokenInput || (existing.apiToken as string) || "";

  const defaultProject = String(
    await prompter.text({
      message: "Default project key (optional)",
      initialValue: (existing.defaultProject as string) ?? "",
      placeholder: "PROJ",
    }),
  ).trim();

  const jira: Record<string, unknown> = {
    enabled: true,
    baseUrl,
    email,
    apiToken,
    ...(defaultProject ? { defaultProject } : {}),
  };

  note(
    [
      `Jira: enabled`,
      `URL: ${baseUrl}`,
      `Email: ${email}`,
      `API token: ${apiToken ? "***" : "not set"}`,
      `Default project: ${defaultProject || "(none)"}`,
    ].join("\n"),
    "Jira configured",
  );

  return setIntegrationsBlock(cfg, { ...integrations, jira });
}

async function setupConfluence(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const integrations = getIntegrationsBlock(cfg);
  const existing = (integrations.confluence as Record<string, unknown>) ?? {};

  note(
    [
      "Confluence integration lets the agent search wiki pages,",
      "read page content, and create/update documentation.",
      "",
      "You'll need:",
      "  - Your Confluence instance URL (e.g. https://yourteam.atlassian.net)",
      "  - An email address associated with your Atlassian account",
      "  - An API token (same as Jira if using Atlassian Cloud)",
    ].join("\n"),
    "Confluence setup",
  );

  const enable = await prompter.confirm({
    message: "Enable Confluence integration?",
    initialValue: existing.enabled === true,
  });

  if (!enable) {
    return setIntegrationsBlock(cfg, {
      ...integrations,
      confluence: { ...existing, enabled: false },
    });
  }

  const baseUrl = String(
    await prompter.text({
      message: "Confluence instance URL",
      initialValue: (existing.baseUrl as string) ?? "",
      placeholder: "https://yourteam.atlassian.net",
      validate: (v) =>
        String(v ?? "")
          .trim()
          .startsWith("http")
          ? undefined
          : "Must be a valid URL starting with http(s)://",
    }),
  ).trim();

  const email = String(
    await prompter.text({
      message: "Confluence account email",
      initialValue: (existing.email as string) ?? "",
      placeholder: "you@example.com",
      validate: (v) =>
        String(v ?? "")
          .trim()
          .includes("@")
          ? undefined
          : "Must be a valid email address",
    }),
  ).trim();

  const hasToken = Boolean(existing.apiToken);
  const tokenInput = String(
    await prompter.text({
      message: hasToken
        ? "Confluence API token (leave blank to keep current)"
        : "Confluence API token",
      placeholder: hasToken ? "Leave blank to keep current" : "Paste your API token",
    }),
  ).trim();
  const apiToken = tokenInput || (existing.apiToken as string) || "";

  const defaultSpace = String(
    await prompter.text({
      message: "Default space key (optional)",
      initialValue: (existing.defaultSpace as string) ?? "",
      placeholder: "TEAM",
    }),
  ).trim();

  const confluence: Record<string, unknown> = {
    enabled: true,
    baseUrl,
    email,
    apiToken,
    ...(defaultSpace ? { defaultSpace } : {}),
  };

  note(
    [
      `Confluence: enabled`,
      `URL: ${baseUrl}`,
      `Email: ${email}`,
      `API token: ${apiToken ? "***" : "not set"}`,
      `Default space: ${defaultSpace || "(none)"}`,
    ].join("\n"),
    "Confluence configured",
  );

  return setIntegrationsBlock(cfg, { ...integrations, confluence });
}

async function setupSlackIntegration(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const integrations = getIntegrationsBlock(cfg);
  const existing = (integrations.slack as Record<string, unknown>) ?? {};

  note(
    [
      "Slack integration lets the agent post messages, read channel history,",
      "search messages, and interact with Slack as a tool.",
      "",
      "You'll need:",
      "  - A Slack Bot User OAuth Token (xoxb-...)",
      "  - Optionally: an App-Level Token (xapp-...) for Socket Mode",
      "  - Optionally: a Signing Secret for webhook verification",
    ].join("\n"),
    "Slack integration setup",
  );

  const enable = await prompter.confirm({
    message: "Enable Slack integration?",
    initialValue: existing.enabled === true,
  });

  if (!enable) {
    return setIntegrationsBlock(cfg, {
      ...integrations,
      slack: { ...existing, enabled: false },
    });
  }

  const hasBotToken = Boolean(existing.botToken);
  const botTokenInput = String(
    await prompter.text({
      message: hasBotToken
        ? "Slack Bot Token (leave blank to keep current)"
        : "Slack Bot Token (xoxb-...)",
      placeholder: hasBotToken ? "Leave blank to keep current" : "xoxb-...",
      validate: (v) => {
        const trimmed = String(v ?? "").trim();
        if (!trimmed && hasBotToken) return undefined;
        if (!trimmed) return "Bot token is required";
        if (!trimmed.startsWith("xoxb-")) return "Bot token should start with xoxb-";
        return undefined;
      },
    }),
  ).trim();
  const botToken = botTokenInput || (existing.botToken as string) || "";

  const hasAppToken = Boolean(existing.appToken);
  const appTokenInput = String(
    await prompter.text({
      message: hasAppToken
        ? "Slack App Token (leave blank to keep current, or skip)"
        : "Slack App Token (xapp-..., optional)",
      placeholder: hasAppToken ? "Leave blank to keep current" : "xapp-... (optional)",
    }),
  ).trim();
  const appToken = appTokenInput || (existing.appToken as string) || "";

  const hasSecret = Boolean(existing.signingSecret);
  const secretInput = String(
    await prompter.text({
      message: hasSecret
        ? "Slack Signing Secret (leave blank to keep current, or skip)"
        : "Slack Signing Secret (optional)",
      placeholder: hasSecret ? "Leave blank to keep current" : "(optional)",
    }),
  ).trim();
  const signingSecret = secretInput || (existing.signingSecret as string) || "";

  const defaultChannel = String(
    await prompter.text({
      message: "Default channel (optional)",
      initialValue: (existing.defaultChannel as string) ?? "",
      placeholder: "#general",
    }),
  ).trim();

  const slack: Record<string, unknown> = {
    enabled: true,
    botToken,
    ...(appToken ? { appToken } : {}),
    ...(signingSecret ? { signingSecret } : {}),
    ...(defaultChannel ? { defaultChannel } : {}),
  };

  note(
    [
      `Slack integration: enabled`,
      `Bot token: ${botToken ? "***" : "not set"}`,
      `App token: ${appToken ? "***" : "not set"}`,
      `Signing secret: ${signingSecret ? "***" : "not set"}`,
      `Default channel: ${defaultChannel || "(none)"}`,
    ].join("\n"),
    "Slack integration configured",
  );

  return setIntegrationsBlock(cfg, { ...integrations, slack });
}
