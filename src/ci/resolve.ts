import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { resolvePlan, type BuildPlan, type WorkflowInputs } from '../config/resolve.js';

/** Marketing version: Expo's static config first, then package.json. */
export function readAppVersion(appDir: string): string | null {
  const readJson = (file: string): any => {
    try {
      return JSON.parse(fs.readFileSync(path.join(appDir, file), 'utf8'));
    } catch {
      return null;
    }
  };
  return readJson('app.json')?.expo?.version ?? readJson('package.json')?.version ?? null;
}

export interface ResolveResult {
  plan: BuildPlan;
  version: string | null;
}

export function runResolve(repoRoot: string, env: NodeJS.ProcessEnv): ResolveResult {
  const inputs: WorkflowInputs = {
    profile: env.INPUT_PROFILE,
    platform: env.INPUT_PLATFORM,
    signing: env.INPUT_SIGNING,
    deliver: env.INPUT_DELIVER,
    submitForReview: env.INPUT_SUBMIT_FOR_REVIEW,
    androidRunner: env.INPUT_ANDROID_RUNNER,
    iosRunner: env.INPUT_IOS_RUNNER,
    xcodeVersion: env.INPUT_XCODE_VERSION,
    nodeVersion: env.INPUT_NODE_VERSION,
    workingDirectory: env.INPUT_WORKING_DIRECTORY,
    buildNumberOffset: env.INPUT_BUILD_NUMBER_OFFSET,
    artifactRetentionDays: env.INPUT_ARTIFACT_RETENTION_DAYS,
  };

  const runNumber = Number(env.GITHUB_RUN_NUMBER ?? '1');
  const { config, file } = loadConfig(repoRoot, env.INPUT_CONFIG_PATH?.trim() || undefined);
  const plan = resolvePlan({ config, hasConfigFile: file !== null, inputs, runNumber });
  const version = readAppVersion(path.resolve(repoRoot, plan.workingDirectory));

  return { plan, version };
}

/** Gradle tasks for the Android job: release outputs when signing, a debug APK otherwise. */
export function androidGradleTasks(plan: BuildPlan): string[] {
  if (!plan.signing) return ['assembleDebug'];
  const tasks: string[] = [];
  if (plan.android.outputs.includes('apk')) tasks.push('assembleRelease');
  if (plan.android.outputs.includes('aab')) tasks.push('bundleRelease');
  return tasks;
}

/** Step outputs consumed by the reusable workflow's later jobs. */
export function toOutputs({ plan, version }: ResolveResult): Record<string, string> {
  const wd = plan.workingDirectory.replace(/\/+$/, '') || '.';
  return {
    plan: JSON.stringify(plan),
    version: version ?? '',
    'build-number': String(plan.buildNumber),
    profile: plan.profile ?? '',
    environment: plan.environment ?? '',
    signing: String(plan.signing),
    'working-directory': wd,
    android: String(plan.android.enabled),
    ios: String(plan.ios.enabled),
    // Always JSON, so the workflow can use fromJSON() for both a single label
    // and a list of self-hosted labels.
    'android-runner': JSON.stringify(plan.android.runner),
    'ios-runner': JSON.stringify(plan.ios.runner),
    'android-gradle-tasks': androidGradleTasks(plan).join(' '),
    // One glob per line, relative to the repo root, as upload-artifact expects.
    'extra-artifact-paths': plan.artifacts.map((glob) => `${wd}/${glob}`).join('\n'),
    'artifact-retention-days': String(plan.artifactRetentionDays),
    'android-deliver': String(Boolean(plan.deliver.firebase || plan.deliver.play)),
    'ios-deliver': String(Boolean(plan.deliver.firebase || plan.deliver.testflight)),
    'testflight-groups': String((plan.deliver.testflight?.groups ?? []).length > 0),
  };
}
