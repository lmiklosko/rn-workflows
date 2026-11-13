import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from '../errors.js';
import type { BuildPlan } from '../config/resolve.js';

/**
 * One `name=value` entry in the format GITHUB_ENV and GITHUB_OUTPUT share.
 * Multi-line values use the heredoc form with a delimiter that cannot occur in
 * the value, so content can never terminate the block early and inject entries.
 */
export function formatKeyValue(name: string, value: string): string {
  if (!value.includes('\n')) return `${name}=${value}\n`;
  const delimiter = `rnw_${randomUUID()}`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

function appendTo(fileVar: 'GITHUB_ENV' | 'GITHUB_OUTPUT', entries: Record<string, string>): void {
  const text = Object.entries(entries)
    .map(([name, value]) => formatKeyValue(name, value))
    .join('');
  const file = process.env[fileVar];
  if (file) {
    fs.appendFileSync(file, text);
  } else {
    // Outside Actions, e.g. when run by hand: show what would be written.
    process.stdout.write(text);
  }
}

/** Makes variables available to every later step of the job. */
export const exportEnv = (entries: Record<string, string>): void => appendTo('GITHUB_ENV', entries);

export const setOutputs = (entries: Record<string, string>): void => appendTo('GITHUB_OUTPUT', entries);

/** Asks the runner to redact a value from all later log output. */
export function mask(value: string): void {
  for (const line of value.split('\n')) {
    if (line.trim()) console.log(`::add-mask::${line}`);
  }
}

export const warn = (message: string): void =>
  console.log(`::warning::${message.replaceAll('\n', '%0A')}`);

/** Directory for decoded credentials. Removed by `ci cleanup`. */
export function scratchDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.RUNNER_TEMP;
  if (!base) throw new UserError('RUNNER_TEMP is not set. This command is meant to run inside GitHub Actions.');
  return path.join(base, 'rnw');
}

export function readPlan(env: NodeJS.ProcessEnv = process.env): BuildPlan {
  const raw = env.RNW_PLAN;
  if (!raw) throw new UserError('RNW_PLAN is not set. Run `rn-workflows ci resolve` first and pass its `plan` output.');
  try {
    return JSON.parse(raw) as BuildPlan;
  } catch {
    throw new UserError('RNW_PLAN is not valid JSON.');
  }
}
