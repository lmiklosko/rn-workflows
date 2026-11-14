import fs from 'node:fs';
import path from 'node:path';
import { password as promptPassword } from '@inquirer/prompts';
import { loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { UserError } from '../errors.js';

export const CREDENTIALS_DIR = '.credentials';

export interface CommonOptions {
  profile: string;
  repo?: string;
  config?: string;
}

export interface ResolvedProfile {
  name: string;
  /** GitHub Environment that holds the profile's secrets. */
  environment: string;
  /** False when the config file exists but does not define the profile. */
  known: boolean;
}

export function resolveProfile(cwd: string, name: string, configPath?: string): ResolvedProfile {
  const { config, file } = loadConfig(cwd, configPath);
  const profile = config.profiles?.[name];
  return { name, environment: profile?.environment ?? name, known: file === null || profile !== undefined };
}

export function listProfiles(config: Config): ResolvedProfile[] {
  return Object.entries(config.profiles ?? {}).map(([name, profile]) => ({
    name,
    environment: profile.environment ?? name,
    known: true,
  }));
}

/** Adds an entry to .gitignore unless a line already covers it. Returns whether the file changed. */
export function ensureGitignored(cwd: string, entry: string): boolean {
  const file = path.join(cwd, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const bare = entry.replace(/^\/|\/$/g, '');
  const covered = existing
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\/|\/$/g, ''))
    .includes(bare);
  if (covered) return false;

  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const block = `${existing ? '\n' : ''}# Signing credentials written by rn-workflows. Never commit these.\n${entry}\n`;
  fs.writeFileSync(file, existing + separator + block);
  return true;
}

/** Directory for the local copy of generated credentials, created private and git-ignored. */
export function credentialsDir(cwd: string, profile: string, platform: 'android' | 'ios'): string {
  ensureGitignored(cwd, `${CREDENTIALS_DIR}/`);
  const dir = path.join(cwd, CREDENTIALS_DIR, profile, platform);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * A password comes from its flag, then its environment variable, then a hidden
 * prompt. Flags end up in shell history, so the variable and the prompt are
 * the forms to prefer.
 */
export async function resolvePassword(
  label: string,
  flag: string | undefined,
  envVar: string,
  options: { allowEmpty?: boolean } = {},
): Promise<string> {
  const value = flag ?? process.env[envVar];
  if (value !== undefined && (value !== '' || options.allowEmpty)) return value;
  if (!process.stdin.isTTY) {
    throw new UserError(`${label} is required. Set ${envVar}, or run in a terminal to be prompted.`);
  }
  return promptPassword({ message: `${label}:`, mask: '*' });
}

export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

export function requireFile(file: string | undefined, what: string): string {
  if (!file) throw new UserError(`${what} is required.`);
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new UserError(`${what} not found: ${file}`);
  }
  return resolved;
}
