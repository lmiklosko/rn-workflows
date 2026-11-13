import { ConfigError } from './load.js';
import {
  DELIVERY_TARGETS,
  type AndroidOutput,
  type Config,
  type DeliverConfig,
  type DeliveryTarget,
  type Runner,
} from './schema.js';

/**
 * Workflow inputs as GitHub hands them over: always strings, and an input the
 * caller left out arrives as an empty string.
 */
export interface WorkflowInputs {
  profile?: string;
  platform?: string;
  signing?: string;
  deliver?: string;
  submitForReview?: string;
  androidRunner?: string;
  iosRunner?: string;
  xcodeVersion?: string;
  nodeVersion?: string;
  workingDirectory?: string;
  buildNumberOffset?: string;
  artifactRetentionDays?: string;
}

export interface BuildPlan {
  /** Profile name, or null for an unsigned verification build. */
  profile: string | null;
  /** GitHub Environment the build jobs run in, or null when unsigned. */
  environment: string | null;
  signing: boolean;
  workingDirectory: string;
  buildNumber: number;
  node: string | null;
  variant: { env: string; value: string } | null;
  android: { enabled: boolean; runner: Runner; outputs: AndroidOutput[] };
  ios: { enabled: boolean; runner: Runner; xcode: string | null };
  deliver: DeliverConfig;
  env: { vars: string[]; secrets: string[] };
  artifacts: string[];
  hooks: { prePrebuild: string | null; postPrebuild: string | null; postBuild: string | null };
  notify: { slack: boolean; teams: boolean };
  artifactRetentionDays: number;
}

const given = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function parseBoolean(name: string, value: string | undefined): boolean | undefined {
  const v = given(value)?.toLowerCase();
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ConfigError(`Input '${name}' must be true or false, got '${value}'.`);
}

function parseInteger(name: string, value: string | undefined): number | undefined {
  const v = given(value);
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) {
    throw new ConfigError(`Input '${name}' must be an integer, got '${value}'.`);
  }
  return Number(v);
}

/** A runner input is a single label, or a JSON array of labels. */
function parseRunner(name: string, value: string | undefined): Runner | undefined {
  const v = given(value);
  if (v === undefined) return undefined;
  if (!v.startsWith('[')) return v;
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((l) => typeof l === 'string')) {
      return parsed as string[];
    }
  } catch {
    // fall through to the error below
  }
  throw new ConfigError(`Input '${name}' must be a label or a JSON array of labels, got '${value}'.`);
}

function parsePlatforms(value: string | undefined): { android: boolean; ios: boolean } {
  const v = given(value)?.toLowerCase() ?? 'all';
  switch (v) {
    case 'all':
      return { android: true, ios: true };
    case 'android':
      return { android: true, ios: false };
    case 'ios':
      return { android: false, ios: true };
    default:
      throw new ConfigError(`Input 'platform' must be ios, android or all, got '${value}'.`);
  }
}

function parseDeliverOverride(value: string | undefined): DeliveryTarget[] | undefined {
  const v = given(value)?.toLowerCase();
  if (v === undefined) return undefined;
  if (v === 'none') return [];
  const targets = v
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of targets) {
    if (!(DELIVERY_TARGETS as readonly string[]).includes(t)) {
      throw new ConfigError(
        `Input 'deliver' names unknown target '${t}'. Known targets: ${DELIVERY_TARGETS.join(', ')}, or none.`,
      );
    }
  }
  return targets as DeliveryTarget[];
}

/**
 * Narrows the profile's delivery config to the targets the caller asked for.
 * A target that is requested but not configured is delivered with defaults.
 */
function applyDeliverOverride(base: DeliverConfig, only: DeliveryTarget[]): DeliverConfig {
  const result: DeliverConfig = {};
  if (only.includes('firebase')) result.firebase = base.firebase ?? {};
  if (only.includes('testflight')) result.testflight = base.testflight ?? {};
  if (only.includes('play')) result.play = base.play ?? { track: 'internal' };
  if (base.submitForReview !== undefined) result.submitForReview = base.submitForReview;
  return result;
}

export interface ResolveOptions {
  config: Config;
  /** False when no config file exists, i.e. the build is driven by inputs alone. */
  hasConfigFile: boolean;
  inputs: WorkflowInputs;
  runNumber: number;
}

/** Merges the config file with workflow inputs. Inputs win. */
export function resolvePlan({ config, hasConfigFile, inputs, runNumber }: ResolveOptions): BuildPlan {
  const profileName = given(inputs.profile) ?? null;
  const profiles = config.profiles ?? {};
  const profile = profileName ? profiles[profileName] : undefined;

  // An unknown profile must fail here. Left alone it would select a GitHub
  // Environment that does not exist, which resolves to no secrets and no
  // variables instead of an error.
  if (profileName && !profile && hasConfigFile) {
    const known = Object.keys(profiles);
    throw new ConfigError(
      `Profile '${profileName}' is not defined in the config file. ` +
        (known.length ? `Defined profiles: ${known.join(', ')}.` : 'It defines no profiles.'),
    );
  }

  const signingInput = given(inputs.signing)?.toLowerCase() ?? 'auto';
  if (signingInput !== 'auto' && signingInput !== 'none') {
    throw new ConfigError(`Input 'signing' must be auto or none, got '${inputs.signing}'.`);
  }
  const signing = signingInput === 'auto' && profileName !== null;

  const deliverOverride = parseDeliverOverride(inputs.deliver);
  let deliver: DeliverConfig = profile?.deliver ?? {};
  if (deliverOverride) deliver = applyDeliverOverride(deliver, deliverOverride);

  const submitForReview = parseBoolean('submit-for-review', inputs.submitForReview);
  if (submitForReview !== undefined) deliver = { ...deliver, submitForReview };

  if (!signing) {
    if (deliverOverride && deliverOverride.length > 0) {
      throw new ConfigError(
        `Input 'deliver' asks for ${deliverOverride.join(', ')}, but this is an unsigned build ` +
          `(${profileName ? "signing is 'none'" : 'no profile given'}). Unsigned builds cannot be distributed.`,
      );
    }
    deliver = {};
  }

  if (deliver.submitForReview && !deliver.testflight && !deliver.play) {
    throw new ConfigError(
      'submitForReview is set, but neither testflight nor play delivery is enabled for this build.',
    );
  }

  const platforms = parsePlatforms(inputs.platform);
  const offset = parseInteger('build-number-offset', inputs.buildNumberOffset) ?? config.buildNumberOffset ?? 0;
  const buildNumber = runNumber + offset;
  if (!Number.isInteger(buildNumber) || buildNumber < 1) {
    throw new ConfigError(`Build number must be a positive integer, got ${buildNumber}.`);
  }

  // An unsigned Android build is a debug APK; there is no debug bundle worth keeping.
  const androidOutputs: AndroidOutput[] = signing
    ? [...new Set(profile?.android?.outputs ?? (['apk', 'aab'] as const))]
    : ['apk'];

  const variantValue = profile?.variant;

  return {
    profile: profileName,
    environment: signing ? (profile?.environment ?? profileName) : null,
    signing,
    workingDirectory: given(inputs.workingDirectory) ?? config.workingDirectory ?? '.',
    buildNumber,
    node: given(inputs.nodeVersion) ?? config.node ?? null,
    variant: variantValue ? { env: config.variantEnv ?? 'APP_VARIANT', value: variantValue } : null,
    android: {
      enabled: platforms.android,
      runner: parseRunner('android-runner', inputs.androidRunner) ?? config.runners?.android ?? 'ubuntu-latest',
      outputs: androidOutputs,
    },
    ios: {
      enabled: platforms.ios,
      runner: parseRunner('ios-runner', inputs.iosRunner) ?? config.runners?.ios ?? 'macos-latest',
      xcode: given(inputs.xcodeVersion) ?? config.xcode ?? null,
    },
    deliver,
    env: {
      vars: config.env?.vars ?? ['EXPO_PUBLIC_*'],
      secrets: config.env?.secrets ?? [],
    },
    artifacts: config.artifacts ?? [],
    hooks: {
      prePrebuild: given(config.hooks?.prePrebuild) ?? null,
      postPrebuild: given(config.hooks?.postPrebuild) ?? null,
      postBuild: given(config.hooks?.postBuild) ?? null,
    },
    notify: {
      slack: config.notify?.slack ?? false,
      teams: config.notify?.teams ?? false,
    },
    artifactRetentionDays:
      parseInteger('artifact-retention-days', inputs.artifactRetentionDays) ??
      config.artifactRetentionDays ??
      14,
  };
}
