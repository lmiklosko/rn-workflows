import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configSchema, type Config } from './schema.js';

export const DEFAULT_CONFIG_FILE = 'rn-workflows.json';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(raw: unknown, source = DEFAULT_CONFIG_FILE): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the file that was read, or null when none exists. */
  file: string | null;
}

/**
 * Reads the config file. A missing file at the default location is not an
 * error: simple builds are driven by workflow inputs alone. A missing file at
 * a path the caller named explicitly is, since that is a typo.
 */
export function loadConfig(repoRoot: string, explicitPath?: string): LoadedConfig {
  const file = path.resolve(repoRoot, explicitPath || DEFAULT_CONFIG_FILE);

  if (!fs.existsSync(file)) {
    if (explicitPath) {
      throw new ConfigError(`Config file not found: ${explicitPath}`);
    }
    return { config: {}, file: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  return { config: parseConfig(raw, path.relative(repoRoot, file)), file };
}
