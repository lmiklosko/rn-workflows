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
import { deliverAndroid, deliverIos, readAscKey, type DeliveryReport } from './ci/deliver.js';
import { collectEnv } from './ci/env.js';
import { installIosCredentials, readIosState, removeIosCredentials, xcodeVersion } from './ci/ios.js';
import { runResolve, toOutputs } from './ci/resolve.js';
import { runAndroidCredentials, type AndroidOptions } from './commands/android.js';
import {
  runAscCredentials,
  runServiceAccountCredentials,
  type AscOptions,
  type ServiceAccountOptions,
} from './commands/delivery.js';
import { runInit, type InitOptions } from './commands/init.js';
import { runIosImport, type IosOptions } from './commands/ios.js';
import { runStatus, type StatusOptions } from './commands/status.js';
import { assignTestFlightGroups } from './deliver/asc.js';
import { UserError } from './errors.js';
import { connect } from './github/context.js';

const program = new Command();

program
  .name('rn-workflows')
  .description('Build and release pipeline for Expo apps on GitHub Actions.');

program
  .command('init')
  .description('Set up a repository: config file, caller workflow, GitHub Environments and signing credentials.')
  .option('--repo <owner/name>', 'GitHub repository (default: the origin remote)')
  .option('--app-dir <dir>', 'directory of the Expo app (default: detected)')
  .option('--profiles <names>', 'comma-separated build profiles')
  .option('--skip-credentials', 'do not ask for signing credentials')
  .option('-y, --yes', 'do not prompt; use flags and defaults')
  .action(async (opts: InitOptions) => {
    await runInit(opts, connect(process.cwd(), opts.repo), process.cwd());
  });

const credentials = program
  .command('credentials')
  .description('Create or update the signing credentials of a build profile.');

credentials
  .command('android')
  .description('Generate an upload keystore, or import an existing one, and store it as Environment secrets.')
  .requiredOption('--profile <name>', 'build profile')
  .option('--generate', 'create a new keystore and keep a local copy under .credentials/')
  .option('--keystore <file>', 'existing keystore to import')
  .option('--properties <file>', 'signing properties file naming storeFile, storePassword, keyAlias, keyPassword')
  .option('--alias <alias>', 'key alias in the keystore')
  .option('--keystore-password <password>', 'prefer ANDROID_KEYSTORE_PASSWORD or the prompt: flags land in shell history')
  .option('--key-password <password>', 'when different from the keystore password; or ANDROID_KEY_PASSWORD')
  .option('--force', 'with --generate, replace a keystore that is already set')
  .option('--repo <owner/name>', 'GitHub repository (default: the origin remote)')
  .option('--config <file>', 'config file (default: rn-workflows.json)')
  .action(async (opts: AndroidOptions) => {
    await runAndroidCredentials(opts, connect(process.cwd(), opts.repo), process.cwd());
  });

credentials
  .command('ios')
  .description('Import a .p12 and/or a .mobileprovision you were given, and store them as Environment secrets.')
  .requiredOption('--profile <name>', 'build profile')
  .option('--p12 <file>', 'signing certificate with its private key')
  .option('--mobileprovision <file>', 'provisioning profile')
  .option('--p12-password <password>', 'prefer IOS_P12_PASSWORD or the prompt: flags land in shell history')
  .option('--repo <owner/name>', 'GitHub repository (default: the origin remote)')
  .option('--config <file>', 'config file (default: rn-workflows.json)')
  .action(async (opts: IosOptions) => {
    await runIosImport(opts, connect(process.cwd(), opts.repo), process.cwd());
  });

for (const [target, what] of [['firebase', 'Firebase App Distribution'], ['play', 'Google Play']] as const) {
  credentials
    .command(target)
    .description(`Store the service account key used to deliver to ${what}.`)
    .requiredOption('--profile <name>', 'build profile')
    .requiredOption('--service-account <file>', 'service account key file (JSON) from Google Cloud')
    .option('--repo <owner/name>', 'GitHub repository (default: the origin remote)')
    .option('--config <file>', 'config file (default: rn-workflows.json)')
    .action(async (opts: ServiceAccountOptions) => {
      await runServiceAccountCredentials(target, opts, connect(process.cwd(), opts.repo), process.cwd());
    });
}

credentials
  .command('testflight')
  .description('Store the App Store Connect API key used to upload to TestFlight.')
  .requiredOption('--profile <name>', 'build profile')
  .requiredOption('--key <file>', 'API key file, AuthKey_<ID>.p8')
  .option('--key-id <id>', 'key ID (default: read from the file name)')
  .option('--issuer-id <uuid>', 'issuer ID; or APP_STORE_CONNECT_API_ISSUER_ID')
  .option('--repo <owner/name>', 'GitHub repository (default: the origin remote)')
  .option('--config <file>', 'config file (default: rn-workflows.json)')
  .action(async (opts: AscOptions) => {
    await runAscCredentials(opts, connect(process.cwd(), opts.repo), process.cwd());
  });

program
  .command('status')
  .description('Show which signing credentials each profile has, and what expires when.')
  .option('--profile <name>', 'only this profile (default: every profile in the config file)')
  .option('--check', 'exit with an error when something is incomplete or expired')
  .option('--repo <owner/name>', 'GitHub repository (default: the origin remote)')
  .option('--config <file>', 'config file (default: rn-workflows.json)')
  .action(async (opts: StatusOptions & { check?: boolean }) => {
    const problems = await runStatus(opts, connect(process.cwd(), opts.repo), process.cwd());
    if (opts.check && problems > 0) {
      throw new UserError(`${problems} problem${problems === 1 ? '' : 's'} found.`);
    }
  });

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

/** A configured target that could not run is a warning on the run, not a failure. */
function reportDelivery(platform: string, report: DeliveryReport): void {
  for (const { target, reason } of report.skipped) {
    warn(`${platform}: ${target} delivery was skipped: ${reason}.`);
  }
  if (!report.delivered.length && !report.skipped.length) console.log('No delivery is configured for this platform.');
  setOutputs({ delivered: report.delivered.join(','), 'testflight-uploaded': String(report.delivered.includes('testflight')) });
}

ci.command('deliver-android')
  .description('Send the Android build to the delivery targets of the plan (Firebase App Distribution, Google Play).')
  .option('--dir <dir>', 'Expo app directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    reportDelivery('Android', await deliverAndroid(readPlan(), path.resolve(opts.dir), scratchDir(), process.env));
  });

ci.command('deliver-ios')
  .description('Send the iOS build to the delivery targets of the plan (Firebase App Distribution, TestFlight).')
  .option('--dir <dir>', 'Expo app directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    reportDelivery('iOS', await deliverIos(readPlan(), path.resolve(opts.dir), scratchDir(), process.env));
    // The TestFlight groups job runs on another machine and needs to know the app.
    setOutputs({ 'bundle-id': process.env.RNW_IOS_BUNDLE_ID ?? '' });
  });

ci.command('testflight-groups')
  .description('Wait for Apple to process the uploaded build, then add it to the TestFlight groups of the plan.')
  .action(async () => {
    const plan = readPlan();
    const groups = plan.deliver.testflight?.groups ?? [];
    if (!groups.length) {
      console.log('No TestFlight groups are configured.');
      return;
    }
    const key = readAscKey(process.env);
    if (typeof key === 'string') throw new UserError(`Cannot assign TestFlight groups: ${key}.`);
    const bundleId = process.env.RNW_IOS_BUNDLE_ID;
    if (!bundleId) throw new UserError('RNW_IOS_BUNDLE_ID is not set.');

    const result = await assignTestFlightGroups({
      key,
      bundleId,
      buildNumber: String(plan.buildNumber),
      version: process.env.RNW_VERSION || null,
      groups,
      log: (message) => console.log(message),
    });
    console.log(`Build ${plan.buildNumber} was added to: ${result.groups.join(', ')}.`);
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
  if (e instanceof Error && e.name === 'ExitPromptError') {
    console.error('Cancelled.');
    process.exit(130);
  }
  if (e instanceof UserError) {
    // ::error:: makes the message an annotation on the run; harmless locally.
    console.error(`::error::${e.message.replaceAll('\n', '%0A')}`);
    process.exit(1);
  }
  throw e;
}
