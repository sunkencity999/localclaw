import { Command } from "commander";
import { registerProgramCommands } from "./command-registry.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";

export function buildProgram() {
  const program = new Command();
  const ctx = createProgramContext();
  const argv = process.argv;

  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  registerProgramCommands(program, ctx, argv);

  // Show help and exit 0 (not 1) when no subcommand is given, so pnpm
  // doesn't print a scary ELIFECYCLE error on bare `pnpm localclaw`.
  program.action(() => {
    program.help({ error: false });
  });

  return program;
}
