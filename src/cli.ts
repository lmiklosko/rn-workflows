#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { buildExportOptions, exportMethodFor, missingEntitlements, parseMobileProvision } from './apple/profile.js';
import { findIosProject, patchInfoPlist, patchXcodeProject, readEntitlements } from './apple/xcodeproj.js';
import { exportEnv, mask, readPlan, scratchDir, setOutputs, warn } from './ci/actions.js';
import {
  findAppBuildScript,
  gradlePropertiesFile,
  installAndroidCredentials,
  patchVersionCode,
  removeAndroidCredentials,
} from './ci/android.js';
import { collectEnv } from './ci/env.js';
import { installIosCredentials, readIosState, removeIosCredentials, xcodeVersion } from './ci/ios.js';
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

ci.command('ios-credentials')
  .description('Install the signing certificate in a temporary keychain and the provisioning profile for Xcode.')
  .action(() => {
    const { profile, state, warnings } = installIosCredentials(
      {
        p12Base64: process.env.IOS_P12_BASE64,
        p12Password: process.env.IOS_P12_PASSWORD,
        profileBase64: process.env.IOS_MOBILEPROVISION_BASE64,
      },
      path.join(scratchDir(), 'ios'),
    );
    warnings.forEach(warn);
    // For app config plugins that need the signing identity during prebuild,
    // e.g. to generate apple-app-site-association.
    exportEnv({
      RNW_IOS_TEAM_ID: profile.teamId,
      RNW_IOS_BUNDLE_ID: profile.bundleId ?? '',
      RNW_IOS_PROFILE_PATH: state.profilePath,
      RNW_IOS_PROFILE_NAME: profile.name,
      RNW_IOS_EXPORT_METHOD: profile.exportMethod,
    });
    console.log(
      `Profile '${profile.name}' (${profile.uuid}) for ${profile.appId}, team ${profile.teamId}, ` +
        `export method ${profile.exportMethod}, expires ${profile.expires.toISOString().slice(0, 10)}.`,
    );
    console.log(`Signing identity: ${state.identity}`);
  });

ci.command('patch-ios')
  .description('Write the build number and, when signing, the signing settings into the generated Xcode project.')
  .option('--dir <dir>', 'Expo app directory', process.cwd())
  .action((opts: { dir: string }) => {
    const plan = readPlan();
    const project = findIosProject(path.resolve(opts.dir));

    let profile = null;
    let signing = null;
    if (plan.signing) {
      const state = readIosState(path.join(scratchDir(), 'ios'));
      if (!state?.identity) {
        throw new UserError('Signing credentials are not installed. Run `rn-workflows ci ios-credentials` before `patch-ios`.');
      }
      profile = parseMobileProvision(fs.readFileSync(state.profilePath));
      signing = {
        teamId: profile.teamId,
        profileName: profile.name,
        profileUuid: profile.uuid,
        identity: state.identity,
        bundleId: profile.bundleId,
      };
    }

    const result = patchXcodeProject(project.pbxproj, plan.buildNumber, signing);
    if (result.infoPlist) patchInfoPlist(path.join(project.iosDir, result.infoPlist), plan.buildNumber);
    console.log(`Set build number ${plan.buildNumber} on target '${result.targetName}'.`);

    if (profile) {
      console.log(`Release configuration signs as ${result.bundleId} with profile '${profile.name}'.`);

      // Checked now because xcodebuild only reports it at the end of the archive.
      const declared = result.entitlements ? readEntitlements(path.join(project.iosDir, result.entitlements)) : {};
      const missing = missingEntitlements(declared, profile);
      if (missing.length) {
        throw new UserError(
          `The app declares entitlements that provisioning profile '${profile.name}' does not grant: ${missing.join(', ')}.\n` +
            `Enable the matching capabilities on the ${result.bundleId} App ID at developer.apple.com, regenerate the profile ` +
            '(changing an App ID invalidates existing profiles), and update IOS_MOBILEPROVISION_BASE64.',
        );
      }
    }

    exportEnv({
      RNW_IOS_WORKSPACE: project.workspace ?? '',
      RNW_IOS_PROJECT: project.project,
      RNW_IOS_SCHEME: project.scheme,
      RNW_IOS_BUNDLE_ID: result.bundleId,
    });
  });

ci.command('ios-export-options')
  .description('Write the ExportOptions.plist matching the installed provisioning profile.')
  .requiredOption('--out <file>', 'where to write the plist')
  .action((opts: { out: string }) => {
    const state = readIosState(path.join(scratchDir(), 'ios'));
    if (!state) throw new UserError('Signing credentials are not installed. Run `rn-workflows ci ios-credentials` first.');
    const profile = parseMobileProvision(fs.readFileSync(state.profilePath));
    const bundleId = profile.bundleId ?? process.env.RNW_IOS_BUNDLE_ID;
    if (!bundleId) throw new UserError('The bundle identifier is unknown. Run `rn-workflows ci patch-ios` first.');

    const method = exportMethodFor(profile.exportMethod, xcodeVersion());
    fs.writeFileSync(opts.out, buildExportOptions({ method, teamId: profile.teamId, bundleId, profileName: profile.name }));
    console.log(`Export method ${method} for ${bundleId}.`);
  });

ci.command('cleanup')
  .description('Remove decoded credentials. Safe to run when nothing was installed.')
  .action(() => {
    removeAndroidCredentials(gradlePropertiesFile());
    if (process.env.RUNNER_TEMP) {
      removeIosCredentials(path.join(scratchDir(), 'ios'));
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
