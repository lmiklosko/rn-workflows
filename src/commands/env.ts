import fs from 'node:fs';
import { parseDotenv } from '../ci/env.js';
import { loadConfig } from '../config/load.js';
import { UserError } from '../errors.js';
import type { GitHub } from '../github/client.js';
import { WORKFLOW_SECRETS } from '../secrets.js';
import { requireFile, resolveProfile, type CommonOptions } from './shared.js';

export interface EnvOptions extends CommonOptions {
  file?: string;
  dryRun?: boolean;
}

export interface EnvSplit {
  /** Sent as plain Environment variables: readable in GitHub, and compiled into the app anyway. */
  variables: Record<string, string>;
  /** Sent together as the APP_ENV secret. */
  secrets: Record<string, string>;
  /** Left out, with the reason. */
  skipped: { name: string; reason: string }[];
}

const patternToRegExp = (pattern: string): RegExp =>
  new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

const RESERVED = /^(GITHUB_|RUNNER_|ACTIONS_|RNW_)/;
const RESERVED_NAMES = new Set(['PATH', 'HOME', 'CI', 'NODE_OPTIONS', 'JAVA_HOME', 'ANDROID_HOME', 'GRADLE_USER_HOME', 'NODE_ENV']);
/** Signing values kept in local env files by older setups; the workflow gets these from `credentials`. */
const SIGNING = /^(ANDROID_KEYSTORE_|ANDROID_KEY_|ANDROID_VERSION_CODE$|IOS_P12_|IOS_MOBILEPROVISION_|IOS_BUILD_NUMBER$|BUILD_NUMBER$)/;

/**
 * Sorts the entries of a local env file into what the build should receive
 * and how. Names matching the config's `env.vars` patterns are public by
 * nature (EXPO_PUBLIC_ values ship inside the app), everything else is
 * treated as a secret.
 */
export function splitEnv(entries: Record<string, string>, varPatterns: string[]): EnvSplit {
  const patterns = varPatterns.map(patternToRegExp);
  const split: EnvSplit = { variables: {}, secrets: {}, skipped: [] };

  for (const [name, value] of Object.entries(entries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      split.skipped.push({ name, reason: 'not a valid variable name' });
    } else if (SIGNING.test(name) || (WORKFLOW_SECRETS as readonly string[]).includes(name)) {
      split.skipped.push({ name, reason: 'signing and build numbers are handled by rn-workflows itself' });
    } else if (RESERVED.test(name) || RESERVED_NAMES.has(name)) {
      split.skipped.push({ name, reason: 'reserved by the runner or the toolchain' });
    } else if (value === '') {
      split.skipped.push({ name, reason: 'empty' });
    } else if (patterns.some((p) => p.test(name))) {
      split.variables[name] = value;
    } else {
      split.secrets[name] = value;
    }
  }
  return split;
}

/** Serialises entries back to dotenv, quoting so that parseDotenv returns the same values. */
export function toDotenv(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([name, value]) => `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join('\n');
}

/** Uploads a local env file as the build environment of a profile. */
export async function runEnv(options: EnvOptions, github: GitHub, cwd: string): Promise<void> {
  const file = requireFile(options.file, 'An env file (--file)');
  const profile = resolveProfile(cwd, options.profile, options.config);
  const patterns = loadConfig(cwd, options.config).config.env?.vars ?? ['EXPO_PUBLIC_*'];
  const split = splitEnv(parseDotenv(fs.readFileSync(file, 'utf8')), patterns);

  const variableNames = Object.keys(split.variables);
  const secretNames = Object.keys(split.secrets);
  // Names only: values of the secret half must not reach the terminal or a log.
  console.log(`As variables (${patterns.join(', ')}): ${variableNames.join(', ') || 'none'}`);
  console.log(`As the APP_ENV secret: ${secretNames.join(', ') || 'none'}`);
  for (const { name, reason } of split.skipped) console.log(`Skipped ${name}: ${reason}`);

  if (!variableNames.length && !secretNames.length) {
    throw new UserError('Nothing to upload: the file has no usable entries.');
  }
  if (options.dryRun) {
    console.log('Dry run: nothing was uploaded.');
    return;
  }

  await github.ensureEnvironment(profile.environment);
  await github.setVariables(profile.environment, split.variables);
  // APP_ENV is one value, so it is replaced as a whole; the file is the source of truth.
  if (secretNames.length) {
    await github.setSecrets(profile.environment, { APP_ENV: toDotenv(split.secrets) });
  }
  console.log(`Build environment is set for environment '${profile.environment}' in ${github.slug}.`);
  if (!secretNames.length) console.log('APP_ENV was left as it is: the file has no secret entries.');
}
