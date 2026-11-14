/**
 * Every secret the reusable workflow accepts. A calling workflow must pass each
 * one by name: `secrets: inherit` is ignored across repository owners.
 * A test keeps this list and build.yml's `workflow_call.secrets` identical.
 */
export const WORKFLOW_SECRETS = [
  'ANDROID_KEYSTORE_BASE64',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
  'IOS_P12_BASE64',
  'IOS_P12_PASSWORD',
  'IOS_MOBILEPROVISION_BASE64',
  'APP_ENV',
] as const;

export const ANDROID_SIGNING_SECRETS = {
  required: ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS'],
  optional: ['ANDROID_KEY_PASSWORD'],
} as const;

export const IOS_SIGNING_SECRETS = {
  required: ['IOS_P12_BASE64', 'IOS_P12_PASSWORD', 'IOS_MOBILEPROVISION_BASE64'],
  optional: [],
} as const;

/** Workflow this version of the CLI scaffolds callers for. */
export const WORKFLOW_REF = 'lmiklosko/rn-workflows/.github/workflows/build.yml@main';
export const SCHEMA_URL = 'https://raw.githubusercontent.com/lmiklosko/rn-workflows/main/schema/rn-workflows.schema.json';
