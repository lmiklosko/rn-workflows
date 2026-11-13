import { z } from 'zod';

/** A runner label, or a list of labels for self-hosted runners. */
const runner = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const hooks = z
  .strictObject({
    prePrebuild: z.string().optional().describe('Shell command run before `expo prebuild`.'),
    postPrebuild: z.string().optional().describe('Shell command run after `expo prebuild`.'),
    postBuild: z.string().optional().describe('Shell command run after the native build.'),
  })
  .describe('Shell commands run inside the build job, from the working directory.');

const firebase = z.strictObject({
  groups: z.array(z.string()).optional().describe('Tester group aliases to notify.'),
  androidAppId: z
    .string()
    .optional()
    .describe('Firebase app ID. Read from google-services.json when omitted.'),
  iosAppId: z
    .string()
    .optional()
    .describe('Firebase app ID. Read from GoogleService-Info.plist when omitted.'),
});

const testflight = z.strictObject({
  groups: z.array(z.string()).optional().describe('Beta groups the build is added to.'),
});

const play = z.strictObject({
  track: z.string().default('internal').describe('Play track the bundle is uploaded to.'),
});

const deliver = z.strictObject({
  firebase: firebase.optional(),
  testflight: testflight.optional(),
  play: play.optional(),
  submitForReview: z
    .boolean()
    .optional()
    .describe('Submit the uploaded store build for review. Off by default.'),
});

const androidOutput = z.enum(['apk', 'aab']);

const profile = z.strictObject({
  environment: z
    .string()
    .optional()
    .describe('GitHub Environment holding this profile\'s secrets. Defaults to the profile name.'),
  variant: z
    .string()
    .optional()
    .describe('Value exported in the variant env var (see `variantEnv`) for app.config to read.'),
  android: z
    .strictObject({
      outputs: z.array(androidOutput).min(1).optional(),
    })
    .optional(),
  deliver: deliver.optional(),
});

export const configSchema = z.strictObject({
  $schema: z.string().optional(),
  workingDirectory: z
    .string()
    .optional()
    .describe('Directory of the Expo app, relative to the repo root. Defaults to ".".'),
  variantEnv: z
    .string()
    .optional()
    .describe('Name of the env var that carries the profile\'s `variant`. Defaults to APP_VARIANT.'),
  buildNumberOffset: z
    .number()
    .int()
    .optional()
    .describe('Added to the GitHub run number to form the build number.'),
  node: z.string().optional().describe('Node version. Defaults to .nvmrc, then the runner default.'),
  xcode: z.string().optional().describe('Xcode version to select. Defaults to the runner default.'),
  runners: z
    .strictObject({
      android: runner.optional(),
      ios: runner.optional(),
    })
    .optional(),
  env: z
    .strictObject({
      vars: z
        .array(z.string())
        .optional()
        .describe('Environment variables to expose to the build. `*` wildcards allowed.'),
      secrets: z
        .array(z.string())
        .optional()
        .describe('Secrets to expose to the build, by exact name.'),
    })
    .optional(),
  artifacts: z
    .array(z.string())
    .optional()
    .describe('Extra globs, relative to the working directory, uploaded with the build.'),
  hooks: hooks.optional(),
  profiles: z.record(z.string().min(1), profile).optional(),
  notify: z
    .strictObject({
      slack: z.boolean().optional(),
      teams: z.boolean().optional(),
    })
    .optional(),
  artifactRetentionDays: z.number().int().min(1).max(90).optional(),
});

export type Config = z.infer<typeof configSchema>;
export type ProfileConfig = z.infer<typeof profile>;
export type DeliverConfig = z.infer<typeof deliver>;
export type AndroidOutput = z.infer<typeof androidOutput>;
export type Runner = z.infer<typeof runner>;

export const DELIVERY_TARGETS = ['firebase', 'testflight', 'play'] as const;
export type DeliveryTarget = (typeof DELIVERY_TARGETS)[number];
