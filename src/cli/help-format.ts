import { theme } from "../terminal/theme.js";
import { replaceCliName } from "./cli-name.js";

export type HelpExample = readonly [command: string, description: string];

export function formatHelpExample(command: string, description: string): string {
  const normalizedCommand = replaceCliName(command);
  return `  ${theme.command(normalizedCommand)}\n    ${theme.muted(description)}`;
}

export function formatHelpExampleLine(command: string, description: string): string {
  const normalizedCommand = replaceCliName(command);
  if (!description) {
    return `  ${theme.command(normalizedCommand)}`;
  }
  return `  ${theme.command(normalizedCommand)} ${theme.muted(`# ${description}`)}`;
}

export function formatHelpExamples(examples: ReadonlyArray<HelpExample>, inline = false): string {
  const formatter = inline ? formatHelpExampleLine : formatHelpExample;
  return examples.map(([command, description]) => formatter(command, description)).join("\n");
}

export function formatHelpExampleGroup(
  label: string,
  examples: ReadonlyArray<HelpExample>,
  inline = false,
) {
  return `${theme.muted(label)}\n${formatHelpExamples(examples, inline)}`;
}
