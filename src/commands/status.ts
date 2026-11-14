import { loadConfig } from '../config/load.js';
import type { GitHub, NamedItem, Variable } from '../github/client.js';
import { GitHubError } from '../github/client.js';
import { ANDROID_SIGNING_SECRETS, IOS_SIGNING_SECRETS } from '../secrets.js';
import { deliveryStatus } from './delivery.js';
import { listProfiles, resolveProfile, type ResolvedProfile } from './shared.js';

const DAY = 24 * 60 * 60 * 1000;

export interface PlatformStatus {
  /** `ready` has every required secret, `partial` some, `none` nothing. */
  state: 'ready' | 'partial' | 'none';
  missing: string[];
  lines: string[];
  /** Problems worth failing a check on: missing pieces of a started setup, or something expired. */
  problems: string[];
}

function describeExpiry(what: string, isoDay: string | undefined, now: Date): { line?: string; problem?: string } {
  if (!isoDay) return {};
  const expires = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(expires.getTime())) return {};
  const days = Math.floor((expires.getTime() - now.getTime()) / DAY);
  if (days < 0) return { line: `${what} EXPIRED on ${isoDay}`, problem: `${what} expired on ${isoDay}` };
  if (days <= 30) return { line: `${what} expires ${isoDay} (in ${days} days, renew soon)` };
  return { line: `${what} expires ${isoDay} (in ${days} days)` };
}

export function platformStatus(
  platform: 'android' | 'ios',
  secrets: NamedItem[],
  variables: Variable[],
  now: Date = new Date(),
): PlatformStatus {
  const expected = platform === 'android' ? ANDROID_SIGNING_SECRETS : IOS_SIGNING_SECRETS;
  const byName = new Map(secrets.map((s) => [s.name, s]));
  const vars = Object.fromEntries(variables.map((v) => [v.name, v.value]));

  const missing = expected.required.filter((name) => !byName.has(name));
  const present = expected.required.length - missing.length;
  const state = missing.length === 0 ? 'ready' : present === 0 ? 'none' : 'partial';

  const lines: string[] = [];
  const problems: string[] = [];
  if (state === 'none') {
    lines.push('not set up');
    return { state, missing: [...missing], lines, problems };
  }

  const updated = [...expected.required, ...expected.optional]
    .map((name) => byName.get(name)?.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  lines.push(state === 'ready' ? `ready, secrets last updated ${updated?.slice(0, 10)}` : `INCOMPLETE, missing ${missing.join(', ')}`);
  if (state === 'partial') problems.push(`missing ${missing.join(', ')}`);

  if (platform === 'android') {
    if (vars.ANDROID_CERT_SHA256) lines.push(`certificate SHA-256 ${vars.ANDROID_CERT_SHA256}`);
  } else {
    if (vars.IOS_CERT_NAME) lines.push(`certificate ${vars.IOS_CERT_NAME}`);
    if (vars.IOS_PROFILE_NAME) {
      lines.push(`profile '${vars.IOS_PROFILE_NAME}' for ${vars.IOS_BUNDLE_ID ?? '?'} (${vars.IOS_EXPORT_METHOD ?? '?'})`);
    }
    for (const [what, key] of [['certificate', 'IOS_CERT_EXPIRES'], ['profile', 'IOS_PROFILE_EXPIRES']] as const) {
      const { line, problem } = describeExpiry(what, vars[key], now);
      if (line) lines.push(line);
      if (problem) problems.push(problem);
    }
  }
  return { state, missing: [...missing], lines, problems };
}

export interface StatusOptions {
  profile?: string;
  repo?: string;
  config?: string;
}

/** Prints what is configured per profile. Returns the number of problems found. */
export async function runStatus(options: StatusOptions, github: GitHub, cwd: string): Promise<number> {
  let profiles: ResolvedProfile[];
  if (options.profile) {
    profiles = [resolveProfile(cwd, options.profile, options.config)];
  } else {
    profiles = listProfiles(loadConfig(cwd, options.config).config);
    if (!profiles.length) {
      console.log('No profiles are defined in the config file. Pass --profile <name> to inspect a GitHub Environment directly.');
      return 0;
    }
  }

  console.log(`Repository ${github.slug}\n`);
  let problems = 0;
  for (const profile of profiles) {
    const label = profile.environment === profile.name ? profile.name : `${profile.name} (environment ${profile.environment})`;
    console.log(`Profile ${label}`);

    let secrets: NamedItem[];
    let variables: Variable[];
    try {
      [secrets, variables] = await Promise.all([github.listSecrets(profile.environment), github.listVariables(profile.environment)]);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) {
        console.log('  environment does not exist yet\n');
        continue;
      }
      throw e;
    }

    for (const [title, platform] of [['Android', 'android'], ['iOS', 'ios']] as const) {
      const status = platformStatus(platform, secrets, variables);
      status.lines.forEach((line, index) => console.log(`  ${index === 0 ? title.padEnd(9) : ' '.repeat(9)}${line}`));
      problems += status.problems.length;
    }
    const delivery = deliveryStatus(secrets, variables);
    console.log(`  ${'Delivery'.padEnd(9)}${delivery.line}`);
    problems += delivery.problems.length;
    console.log('');
  }
  return problems;
}
