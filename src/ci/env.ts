import { UserError } from '../errors.js';
import type { BuildPlan } from '../config/resolve.js';

export interface EnvEntry {
  name: string;
  value: string;
  secret: boolean;
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names an app must not set through config: they would change how the runner
 * or the toolchain itself behaves, not just the app build.
 */
const isReserved = (name: string): boolean =>
  /^(GITHUB_|RUNNER_|ACTIONS_|RNW_)/.test(name) ||
  ['PATH', 'HOME', 'CI', 'NODE_OPTIONS', 'JAVA_HOME', 'ANDROID_HOME', 'GRADLE_USER_HOME'].includes(name);

/**
 * Parses dotenv content: `KEY=value` lines, `#` comments, optional `export`,
 * optional single or double quotes. Double-quoted values understand `\n`.
 * Values spanning several lines are not supported.
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    // The line itself is not echoed: it may be a secret with a typo in it.
    if (!match) throw new UserError(`APP_ENV line ${index + 1} is not in KEY=value form.`);

    const name = match[1]!;
    let value = match[2]!;

    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: a ` #` starts a trailing comment.
      value = value.replace(/\s+#.*$/, '');
    }
    result[name] = value;
  });

  return result;
}

const patternToRegExp = (pattern: string): RegExp =>
  new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

export interface CollectOptions {
  plan: BuildPlan;
  /** Every configuration variable visible to the job, as `toJSON(vars)` gives it. */
  vars: Record<string, string>;
  /** Content of the APP_ENV secret, if set. */
  appEnv?: string;
}

/**
 * Decides what the app's prebuild and native build get to see. Later sources
 * win: variables, then APP_ENV, then values rn-workflows itself defines.
 */
export function collectEnv({ plan, vars, appEnv }: CollectOptions): EnvEntry[] {
  const entries = new Map<string, EnvEntry>();
  const add = (name: string, value: string, secret: boolean, source: string): void => {
    if (!VALID_NAME.test(name)) {
      throw new UserError(`${source} defines '${name}', which is not a valid environment variable name.`);
    }
    if (isReserved(name)) {
      throw new UserError(`${source} defines '${name}', which is reserved and cannot be set for the build.`);
    }
    entries.set(name, { name, value, secret });
  };

  const patterns = plan.env.vars.map(patternToRegExp);
  for (const [name, value] of Object.entries(vars)) {
    if (patterns.some((p) => p.test(name))) add(name, value, false, 'A GitHub variable');
  }

  if (appEnv?.trim()) {
    for (const [name, value] of Object.entries(parseDotenv(appEnv))) {
      add(name, value, true, 'The APP_ENV secret');
    }
  }

  if (plan.variant) add(plan.variant.env, plan.variant.value, false, 'The config file (variantEnv)');

  // Set last and directly: this is the one RNW_ name the build is meant to read.
  entries.set('RNW_BUILD_NUMBER', { name: 'RNW_BUILD_NUMBER', value: String(plan.buildNumber), secret: false });

  return [...entries.values()];
}
