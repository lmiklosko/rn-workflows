#!/usr/bin/env node
import { Command } from 'commander';
import { runResolve, toOutputs, writeOutputs } from './ci/resolve.js';
import { ConfigError } from './config/load.js';

const program = new Command();

program
  .name('rn-workflows')
  .description('Build and release pipeline for Expo apps on GitHub Actions.');

const ci = program.command('ci').description('Commands run by the shared workflow inside CI.');

ci.command('resolve')
  .description('Merge the config file with workflow inputs and emit the build plan as step outputs.')
  .option('--cwd <dir>', 'repository root', process.cwd())
  .action((opts: { cwd: string }) => {
    const result = runResolve(opts.cwd, process.env);
    writeOutputs(toOutputs(result), process.env.GITHUB_OUTPUT);
    if (process.env.GITHUB_OUTPUT) {
      console.log(JSON.stringify(result.plan, null, 2));
    }
  });

try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof ConfigError) {
    // ::error:: makes the message an annotation on the run; harmless locally.
    console.error(`::error::${e.message.replaceAll('\n', '%0A')}`);
    process.exit(1);
  }
  throw e;
}
