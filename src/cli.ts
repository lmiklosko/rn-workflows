#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { exportEnv, mask, readPlan, scratchDir, setOutputs } from './ci/actions.js';
import {
  findAppBuildScript,
  gradlePropertiesFile,
  installAndroidCredentials,
  patchVersionCode,
  removeAndroidCredentials,
} from './ci/android.js';
import { collectEnv } from './ci/env.js';
import { runResolve, toOutputs } from './ci/resolve.js';
import { UserError } from './errors.js';

const program = new Command();

program
  .name('rn-workflows')
  .description('Build and release pipeline for Expo apps on GitHub Actions.');

const ci = program.command('ci').description('Commands run by the shared workflow inside CI.');

ci.command('resolve')
  .description('Merge the config file with workflow inputs and emit the build plan as step outputs.')
  .option('--cwd <dir>', 'repository root', process.cwd())
  .action((opts: { cwd: string }) => {
    const result = runResolve(opts.cwd, process.env);
    setOutputs(toOutputs(result));
    if (process.env.GITHUB_OUTPUT) {
      console.log(JSON.stringify(result.plan, null, 2));
    }
  });

ci.command('env')
  .description('Export the variables the app build may read to later steps.')
  .action(() => {
    let vars: Record<string, string> = {};
    try {
      vars = JSON.parse(process.env.RNW_VARS_JSON || '{}');
    } catch {
      throw new UserError('RNW_VARS_JSON is not valid JSON.');
    }

    const entries = collectEnv({ plan: readPlan(), vars, appEnv: process.env.RNW_APP_ENV });
    for (const entry of entries) {
      if (entry.secret) mask(entry.value);
    }
    exportEnv(Object.fromEntries(entries.map((e) => [e.name, e.value])));

    for (const entry of entries) {
      console.log(`${entry.name}${entry.secret ? ' (from APP_ENV)' : `=${entry.value}`}`);
    }
  });

ci.command('android-credentials')
  .description('Decode and check the Android keystore, then configure Gradle to sign with it.')
  .action(() => {
    const result = installAndroidCredentials(
      {
        keystoreBase64: process.env.ANDROID_KEYSTORE_BASE64,
        keystorePassword: process.env.ANDROID_KEYSTORE_PASSWORD,
        keyAlias: process.env.ANDROID_KEY_ALIAS,
        keyPassword: process.env.ANDROID_KEY_PASSWORD,
      },
      path.join(scratchDir(), 'android'),
      gradlePropertiesFile(),
    );
    // For app config plugins that need the signing identity during prebuild,
    // e.g. to generate assetlinks.json.
    exportEnv({
      RNW_ANDROID_KEYSTORE_PATH: result.keystorePath,
      RNW_ANDROID_CERT_SHA256: result.certSha256,
    });
    console.log(`Keystore opened. Signing certificate SHA-256: ${result.certSha256}`);
  });

ci.command('patch-android')
  .description('Write the build number into the generated Android project.')
  .option('--dir <dir>', 'Expo app directory', process.cwd())
  .action((opts: { dir: string }) => {
    const { buildNumber } = readPlan();
    const file = findAppBuildScript(path.resolve(opts.dir));
    fs.writeFileSync(file, patchVersionCode(fs.readFileSync(file, 'utf8'), buildNumber));
    console.log(`Set versionCode ${buildNumber} in ${path.relative(process.cwd(), file)}`);
  });

ci.command('cleanup')
  .description('Remove decoded credentials. Safe to run when nothing was installed.')
  .action(() => {
    removeAndroidCredentials(gradlePropertiesFile());
    if (process.env.RUNNER_TEMP) {
      fs.rmSync(scratchDir(), { recursive: true, force: true });
    }
    console.log('Credentials removed.');
  });

try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof UserError) {
    // ::error:: makes the message an annotation on the run; harmless locally.
    console.error(`::error::${e.message.replaceAll('\n', '%0A')}`);
    process.exit(1);
  }
  throw e;
}
