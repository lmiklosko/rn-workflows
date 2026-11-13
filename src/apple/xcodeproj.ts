import fs from 'node:fs';
import path from 'node:path';
import * as plist from 'plist';
import xcode from 'xcode';
import { UserError } from '../errors.js';

export interface SigningSettings {
  teamId: string;
  profileName: string;
  profileUuid: string;
  /** Common name of the signing certificate, e.g. `Apple Distribution: Acme (ABCDE12345)`. */
  identity: string;
  /** Bundle identifier of the profile, or null for a wildcard profile. */
  bundleId: string | null;
}

export interface PatchResult {
  targetName: string;
  /** Bundle identifier the Release build will have. */
  bundleId: string;
  /** Relative to the ios directory. */
  infoPlist: string | null;
  entitlements: string | null;
}

const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const unquote = (value: string | undefined): string | null =>
  value === undefined ? null : value.replace(/^"(.*)"$/, '$1');

/**
 * Sets the build number on the app target and, when signing settings are
 * given, switches its Release configuration to manual signing with them.
 *
 * Only the app target is touched. Passing the same settings on the xcodebuild
 * command line would apply them to every Pods target too and break the build.
 */
export function patchXcodeProject(pbxprojPath: string, buildNumber: number, signing: SigningSettings | null): PatchResult {
  const project = xcode.project(pbxprojPath).parseSync();

  // The app target is the first one; test and extension targets are added after it.
  const target = project.getFirstTarget()?.firstTarget;
  if (!target) throw new UserError(`No target found in ${pbxprojPath}.`);

  const configList = project.pbxXCConfigurationList()[target.buildConfigurationList];
  if (!configList || typeof configList === 'string') {
    throw new UserError(`Target '${unquote(target.name)}' has no build configurations.`);
  }
  const allConfigs = project.pbxXCBuildConfigurationSection();

  let release: Record<string, string | undefined> | null = null;
  for (const ref of configList.buildConfigurations) {
    const config = allConfigs[ref.value];
    if (!config || typeof config === 'string') continue;
    const bs = config.buildSettings;

    bs.CURRENT_PROJECT_VERSION = String(buildNumber);

    if (config.name !== 'Release') continue;
    release = bs;
    if (!signing) continue;

    bs.CODE_SIGN_STYLE = 'Manual';
    bs.CODE_SIGN_IDENTITY = quote(signing.identity);
    bs['"CODE_SIGN_IDENTITY[sdk=iphoneos*]"'] = quote(signing.identity);
    bs.DEVELOPMENT_TEAM = signing.teamId;
    bs['"DEVELOPMENT_TEAM[sdk=iphoneos*]"'] = signing.teamId;
    bs.PROVISIONING_PROFILE_SPECIFIER = quote(signing.profileName);
    bs['"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]"'] = quote(signing.profileName);
    bs.PROVISIONING_PROFILE = quote(signing.profileUuid);
    // The profile decides what the app is called to Apple. A mismatch with the
    // app config would only surface at the end of the archive, in exportArchive.
    if (signing.bundleId) bs.PRODUCT_BUNDLE_IDENTIFIER = quote(signing.bundleId);
  }

  if (!release) throw new UserError(`Target '${unquote(target.name)}' has no Release configuration.`);

  fs.writeFileSync(pbxprojPath, project.writeSync());

  return {
    targetName: unquote(target.name) ?? '',
    bundleId: unquote(release.PRODUCT_BUNDLE_IDENTIFIER) ?? '',
    infoPlist: unquote(release.INFOPLIST_FILE),
    entitlements: unquote(release.CODE_SIGN_ENTITLEMENTS),
  };
}

/** Sets CFBundleVersion, which Expo's template writes as a literal instead of $(CURRENT_PROJECT_VERSION). */
export function patchInfoPlist(file: string, buildNumber: number): void {
  const data = plist.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  data.CFBundleVersion = String(buildNumber);
  fs.writeFileSync(file, plist.build(data) + '\n');
}

export function readEntitlements(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  return plist.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export interface IosProject {
  /** Absolute path of the ios directory. */
  iosDir: string;
  /** File name of the workspace, when CocoaPods has created one. */
  workspace: string | null;
  /** File name of the Xcode project. */
  project: string;
  scheme: string;
  pbxproj: string;
}

/** Finds the generated project, so nothing about its name has to be configured. */
export function findIosProject(appDir: string): IosProject {
  const iosDir = path.join(appDir, 'ios');
  if (!fs.existsSync(iosDir)) {
    throw new UserError(`No ios directory under ${appDir}. Has \`expo prebuild --platform ios\` run?`);
  }
  const entries = fs.readdirSync(iosDir);
  const project = entries.find((e) => e.endsWith('.xcodeproj') && e !== 'Pods.xcodeproj');
  if (!project) throw new UserError(`No .xcodeproj found in ${iosDir}.`);

  const name = project.replace(/\.xcodeproj$/, '');
  const schemesDir = path.join(iosDir, project, 'xcshareddata', 'xcschemes');
  const schemes = fs.existsSync(schemesDir)
    ? fs.readdirSync(schemesDir).filter((s) => s.endsWith('.xcscheme')).map((s) => s.replace(/\.xcscheme$/, ''))
    : [];
  const scheme = schemes.includes(name) ? name : schemes[0];
  if (!scheme) throw new UserError(`No shared scheme found in ${project}.`);

  return {
    iosDir,
    workspace: entries.find((e) => e.endsWith('.xcworkspace')) ?? null,
    project,
    scheme,
    pbxproj: path.join(iosDir, project, 'project.pbxproj'),
  };
}
