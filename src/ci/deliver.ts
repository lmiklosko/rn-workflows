import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseMobileProvision } from '../apple/profile.js';
import type { BuildPlan } from '../config/resolve.js';
import { altoolUploadArgs, validateAscKey, type AscKey } from '../deliver/asc.js';
import { androidFirebaseAppId, firebaseArgs, iosFirebaseAppId } from '../deliver/firebase.js';
import { decodeServiceAccount } from '../deliver/google.js';
import { uploadToPlay } from '../deliver/play.js';
import { UserError } from '../errors.js';
import { decodeBase64Strict, findAppBuildScript } from './android.js';
import { readIosState } from './ios.js';

type Env = NodeJS.ProcessEnv;

export interface DeliveryReport {
  /** Targets that were delivered, e.g. `firebase`. */
  delivered: string[];
  /** Targets that were configured but skipped, with the reason. */
  skipped: { target: string; reason: string }[];
}

/** Injected so tests can observe what would run without running it. */
export interface Runner {
  run(command: string, args: string[], env: Env): void;
  uploadToPlay: typeof uploadToPlay;
}

export const realRunner: Runner = {
  run(command, args, env) {
    const result = spawnSync(command, args, { stdio: 'inherit', env });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UserError(`${command} was not found on this runner.`);
    }
    if (result.status !== 0) {
      throw new UserError(`${command} ${args.find((a) => !a.startsWith('-')) ?? ''} failed with exit code ${result.status}. See its output above.`);
    }
  },
  uploadToPlay,
};

/** Short, useful by default: what changed, which commit, which build. */
export function releaseNotes(env: Env, buildNumber: number, cwd: string): string {
  let subject = '';
  try {
    subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // not a git checkout; the build number still identifies the build
  }
  const sha = (env.GITHUB_SHA ?? '').slice(0, 7);
  const suffix = `(${[sha, `build ${buildNumber}`].filter(Boolean).join(', ')})`;
  return subject ? `${subject} ${suffix}` : suffix;
}

function findOne(dir: string, extension: string, what: string): string {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(extension)).sort() : [];
  if (!files.length) throw new UserError(`No ${what} found in ${dir}. The build did not produce one.`);
  return path.join(dir, files[0]!);
}

export function readApplicationId(appDir: string): string | null {
  try {
    return /\bapplicationId\b\s*=?\s*['"]([^'"]+)['"]/.exec(fs.readFileSync(findAppBuildScript(appDir), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

function writePrivate(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

const missingSecret = (names: string[]): string =>
  `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} not set in this build's GitHub Environment, or not passed by the calling workflow`;

interface FirebaseInput {
  file: string;
  appId: string | null;
  appIdHint: string;
  groups: string[];
}

function deliverFirebase(input: FirebaseInput, plan: BuildPlan, appDir: string, scratch: string, env: Env, runner: Runner): void {
  if (!input.appId) throw new UserError(`The Firebase app ID is unknown. ${input.appIdHint}`);
  const { json } = decodeServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_BASE64!, 'FIREBASE_SERVICE_ACCOUNT_BASE64');
  const keyFile = writePrivate(path.join(scratch, 'firebase'), 'service-account.json', json);
  runner.run(
    'npx',
    firebaseArgs({ file: input.file, appId: input.appId, groups: input.groups, releaseNotes: releaseNotes(env, plan.buildNumber, appDir) }),
    { ...env, GOOGLE_APPLICATION_CREDENTIALS: keyFile },
  );
}

export async function deliverAndroid(plan: BuildPlan, appDir: string, scratch: string, env: Env, runner: Runner = realRunner): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: [], skipped: [] };
  const outputs = path.join(appDir, 'android', 'app', 'build', 'outputs');
  const applicationId = readApplicationId(appDir);

  if (plan.deliver.firebase) {
    if (!env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim()) {
      report.skipped.push({ target: 'firebase', reason: missingSecret(['FIREBASE_SERVICE_ACCOUNT_BASE64']) });
    } else {
      deliverFirebase(
        {
          // The .apk, not the .aab: testers install an .apk straight from the invite.
          file: findOne(path.join(outputs, 'apk', 'release'), '.apk', 'release APK'),
          appId: plan.deliver.firebase.androidAppId ?? androidFirebaseAppId(appDir, applicationId),
          appIdHint: 'Commit google-services.json, or set deliver.firebase.androidAppId in the config file.',
          groups: plan.deliver.firebase.groups ?? [],
        },
        plan, appDir, scratch, env, runner,
      );
      report.delivered.push('firebase');
    }
  }

  if (plan.deliver.play) {
    if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64?.trim()) {
      report.skipped.push({ target: 'play', reason: missingSecret(['GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64']) });
    } else {
      if (!applicationId) throw new UserError('Could not read the applicationId from the generated Android project, which Google Play needs.');
      const { account } = decodeServiceAccount(env.GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64, 'GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64');
      const { versionCode } = await runner.uploadToPlay({
        account,
        packageName: applicationId,
        aabPath: findOne(path.join(outputs, 'bundle', 'release'), '.aab', 'release bundle'),
        track: plan.deliver.play.track,
        status: plan.deliver.play.status,
      });
      console.log(`Google Play: version code ${versionCode} is on the ${plan.deliver.play.track} track of ${applicationId} (${plan.deliver.play.status}).`);
      report.delivered.push('play');
    }
  }
  return report;
}

export async function deliverIos(plan: BuildPlan, appDir: string, scratch: string, env: Env, runner: Runner = realRunner): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: [], skipped: [] };
  if (!plan.deliver.firebase && !plan.deliver.testflight) return report;

  const state = readIosState(path.join(scratch, 'ios'));
  if (!state) throw new UserError('Signing credentials are not installed, so the build type is unknown. Deliver before `rn-workflows ci cleanup`.');
  const method = parseMobileProvision(fs.readFileSync(state.profilePath)).exportMethod;
  const ipaDir = path.join(appDir, 'ios', 'build', 'rnw');

  // Which store a build can go to is decided by its provisioning profile, and
  // each store rejects the other kind minutes into the upload.
  if (plan.deliver.firebase) {
    if (method === 'app-store-connect') {
      report.skipped.push({ target: 'firebase', reason: 'this is an App Store build, which testers cannot install; Firebase needs an ad hoc, development or enterprise profile' });
    } else if (!env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim()) {
      report.skipped.push({ target: 'firebase', reason: missingSecret(['FIREBASE_SERVICE_ACCOUNT_BASE64']) });
    } else {
      deliverFirebase(
        {
          file: findOne(ipaDir, '.ipa', 'IPA'),
          appId: plan.deliver.firebase.iosAppId ?? iosFirebaseAppId(appDir),
          appIdHint: 'Commit GoogleService-Info.plist, or set deliver.firebase.iosAppId in the config file.',
          groups: plan.deliver.firebase.groups ?? [],
        },
        plan, appDir, scratch, env, runner,
      );
      report.delivered.push('firebase');
    }
  }

  if (plan.deliver.testflight) {
    const key = readAscKey(env);
    if (method !== 'app-store-connect') {
      report.skipped.push({ target: 'testflight', reason: `the provisioning profile is for ${method}, and App Store Connect only accepts App Store builds` });
    } else if (typeof key === 'string') {
      report.skipped.push({ target: 'testflight', reason: key });
    } else {
      // altool takes the key ID, not a path: it looks for AuthKey_<ID>.p8 in
      // a few fixed directories plus this one.
      const keyDir = path.join(scratch, 'asc');
      writePrivate(keyDir, `AuthKey_${key.keyId}.p8`, key.privateKey);
      runner.run('xcrun', altoolUploadArgs(findOne(ipaDir, '.ipa', 'IPA'), key), { ...env, API_PRIVATE_KEYS_DIR: keyDir });
      console.log('Uploaded to App Store Connect. Apple takes a few minutes to process a build before it appears in TestFlight.');
      report.delivered.push('testflight');
    }
  }
  return report;
}

/** Returns the key, or the reason it is unavailable. A malformed key throws. */
export function readAscKey(env: Env): AscKey | string {
  const names = ['APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_API_ISSUER_ID', 'APP_STORE_CONNECT_API_KEY_BASE64'];
  const missing = names.filter((n) => !env[n]?.trim());
  if (missing.length) return missingSecret(missing);
  return validateAscKey({
    keyId: env.APP_STORE_CONNECT_API_KEY_ID,
    issuerId: env.APP_STORE_CONNECT_API_ISSUER_ID,
    privateKey: decodeBase64Strict(env.APP_STORE_CONNECT_API_KEY_BASE64!, 'APP_STORE_CONNECT_API_KEY_BASE64').toString('utf8'),
  });
}
