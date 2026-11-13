import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as plist from 'plist';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildExportOptions,
  exportMethodFor,
  missingEntitlements,
  parseMobileProvision,
} from '../src/apple/profile.js';
import { findIosProject, patchInfoPlist, patchXcodeProject } from '../src/apple/xcodeproj.js';
import { checkExpiry, parseIdentity, parseKeychainList } from '../src/ci/ios.js';
import { UserError } from '../src/errors.js';

const fixtures = path.resolve(import.meta.dirname, 'fixtures/ios');

/** A profile body wrapped in bytes that are not XML, like the real CMS envelope. */
const fakeProfile = (body: string): Buffer =>
  Buffer.concat([
    Buffer.from([0x30, 0x82, 0x1f, 0xff, 0x06, 0x09]),
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
        <key>UUID</key><string>abc-123</string>
        <key>Name</key><string>Acme Çé Store</string>
        <key>TeamIdentifier</key><array><string>TEAM123456</string></array>
        <key>ExpirationDate</key><date>2030-01-02T03:04:05Z</date>
        ${body}
      </dict></plist>`,
      'utf8',
    ),
    Buffer.from([0xa0, 0x82, 0x00]),
  ]);

const entitlements = (appId: string, extra = '') =>
  `<key>Entitlements</key><dict><key>application-identifier</key><string>${appId}</string>${extra}</dict>`;

describe('parseMobileProvision', () => {
  it('reads identity fields out of the signed envelope', () => {
    const profile = parseMobileProvision(fakeProfile(entitlements('TEAM123456.com.acme.app')));
    expect(profile).toMatchObject({
      uuid: 'abc-123',
      name: 'Acme Çé Store',
      teamId: 'TEAM123456',
      appId: 'TEAM123456.com.acme.app',
      bundleId: 'com.acme.app',
      exportMethod: 'app-store-connect',
      certificates: [],
    });
    expect(profile.expires.toISOString()).toBe('2030-01-02T03:04:05.000Z');
  });

  it('derives the export method from the profile', () => {
    const devices = '<key>ProvisionedDevices</key><array><string>udid</string></array>';
    const method = (body: string) => parseMobileProvision(fakeProfile(body)).exportMethod;
    expect(method(entitlements('T.a') + devices)).toBe('release-testing');
    expect(method(entitlements('T.a', '<key>get-task-allow</key><true/>') + devices)).toBe('debugging');
    expect(method(entitlements('T.a') + '<key>ProvisionsAllDevices</key><true/>')).toBe('enterprise');
    expect(method(entitlements('T.a'))).toBe('app-store-connect');
  });

  it('treats a wildcard app ID as having no bundle identifier', () => {
    expect(parseMobileProvision(fakeProfile(entitlements('TEAM123456.*'))).bundleId).toBeNull();
    expect(parseMobileProvision(fakeProfile(entitlements('TEAM123456.com.acme.*'))).bundleId).toBeNull();
  });

  it('rejects files that are not profiles', () => {
    expect(() => parseMobileProvision(Buffer.from('not a profile'))).toThrow(/IOS_MOBILEPROVISION_BASE64/);
    expect(() => parseMobileProvision(fakeProfile(''))).toThrow(/missing its UUID, name, team or application identifier/);
  });
});

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)('parseMobileProvision with a CMS-signed profile', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnw-ios-'));
    execFileSync(path.resolve(import.meta.dirname, '../scripts/make-fake-ios-credentials.sh'), [dir, 'com.acme.adhoc']);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the embedded certificate and matches it by fingerprint', () => {
    const profile = parseMobileProvision(fs.readFileSync(path.join(dir, 'profile.mobileprovision')));
    const expected = execFileSync('openssl', ['x509', '-in', path.join(dir, 'cert.pem'), '-noout', '-fingerprint', '-sha1'], { encoding: 'utf8' })
      .replace(/^.*=/, '')
      .replaceAll(':', '')
      .trim()
      .toLowerCase();

    expect(profile.bundleId).toBe('com.acme.adhoc');
    expect(profile.exportMethod).toBe('release-testing');
    expect(profile.certificates).toHaveLength(1);
    expect(profile.certificates[0]!.sha1).toBe(expected);
    expect(profile.certificates[0]!.commonName).toBe('Apple Distribution: rn-workflows Fake (FAKETEAM01)');

    expect(checkExpiry(profile, expected).warnings).toEqual([]);
    const soon = new Date(profile.expires.getTime() - 3 * 24 * 60 * 60 * 1000 + 1000);
    expect(checkExpiry(profile, expected, soon).warnings).toEqual([
      expect.stringMatching(/^Provisioning profile 'rn-workflows Fake Ad Hoc' expires in 2 days/),
      expect.stringMatching(/^Signing certificate 'Apple Distribution: rn-workflows Fake \(FAKETEAM01\)' expires in \d days/),
    ]);
    const after = new Date(profile.expires.getTime() + 1000);
    expect(() => checkExpiry(profile, expected, after)).toThrow(/expired on/);
  });
});

describe('export options', () => {
  it('uses the method names the installed Xcode understands', () => {
    expect(exportMethodFor('app-store-connect', '16.4')).toBe('app-store-connect');
    expect(exportMethodFor('release-testing', '15.3')).toBe('release-testing');
    expect(exportMethodFor('release-testing', '15.2')).toBe('ad-hoc');
    expect(exportMethodFor('app-store-connect', '14.3.1')).toBe('app-store');
    expect(exportMethodFor('debugging', '15.0')).toBe('development');
    expect(exportMethodFor('enterprise', null)).toBe('enterprise');
  });

  it('maps the bundle identifier to the profile for manual signing', () => {
    const options = plist.parse(
      buildExportOptions({ method: 'app-store-connect', teamId: 'TEAM123456', bundleId: 'com.acme.app', profileName: 'Acme Store' }),
    );
    expect(options).toEqual({
      method: 'app-store-connect',
      teamID: 'TEAM123456',
      signingStyle: 'manual',
      provisioningProfiles: { 'com.acme.app': 'Acme Store' },
    });
  });

  it('lists entitlements the profile does not grant', () => {
    const profile = parseMobileProvision(fakeProfile(entitlements('T.a', '<key>aps-environment</key><string>production</string>')));
    expect(missingEntitlements({ 'aps-environment': 'production' }, profile)).toEqual([]);
    expect(missingEntitlements({ 'aps-environment': 'x', 'com.apple.developer.associated-domains': [] }, profile)).toEqual([
      'com.apple.developer.associated-domains',
    ]);
  });
});

describe('Xcode project patching', () => {
  let dir: string;
  let pbxproj: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnw-xcode-'));
    const projectDir = path.join(dir, 'ios', 'rnworkflowsexample.xcodeproj');
    fs.mkdirSync(path.join(projectDir, 'xcshareddata', 'xcschemes'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'xcshareddata', 'xcschemes', 'rnworkflowsexample.xcscheme'), '');
    fs.mkdirSync(path.join(dir, 'ios', 'rnworkflowsexample.xcworkspace'));
    pbxproj = path.join(projectDir, 'project.pbxproj');
    fs.copyFileSync(path.join(fixtures, 'project.pbxproj'), pbxproj);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Build settings of the app target, by configuration name, as written to disk. */
  const appSettings = (): Record<string, string> => {
    const text = fs.readFileSync(pbxproj, 'utf8');
    const blocks = [...text.matchAll(/buildSettings = \{([\s\S]*?)\n\t\t\t\};\n\t\t\tname = (\w+);/g)];
    return Object.fromEntries(blocks.filter((b) => b[1]!.includes('INFOPLIST_FILE')).map((b) => [b[2]!, b[1]!]));
  };

  it('finds the workspace, project and scheme', () => {
    expect(findIosProject(dir)).toMatchObject({
      workspace: 'rnworkflowsexample.xcworkspace',
      project: 'rnworkflowsexample.xcodeproj',
      scheme: 'rnworkflowsexample',
    });
    expect(() => findIosProject(os.tmpdir())).toThrow(/expo prebuild --platform ios/);
  });

  it('sets only the build number for an unsigned build', () => {
    const result = patchXcodeProject(pbxproj, 42, null);
    expect(result).toEqual({
      targetName: 'rnworkflowsexample',
      bundleId: 'dev.rnworkflows.example',
      infoPlist: 'rnworkflowsexample/Info.plist',
      entitlements: 'rnworkflowsexample/rnworkflowsexample.entitlements',
    });
    const settings = appSettings();
    expect(settings.Debug).toContain('CURRENT_PROJECT_VERSION = 42;');
    expect(settings.Release).toContain('CURRENT_PROJECT_VERSION = 42;');
    expect(settings.Release).not.toContain('CODE_SIGN_STYLE');
  });

  it('switches only the Release configuration of the app target to manual signing', () => {
    const result = patchXcodeProject(pbxproj, 7, {
      teamId: 'TEAM123456',
      profileName: 'Acme "Store" Profile',
      profileUuid: 'abc-123',
      identity: 'Apple Distribution: Acme Ltd (TEAM123456)',
      bundleId: 'com.acme.app',
    });
    expect(result.bundleId).toBe('com.acme.app');

    const settings = appSettings();
    expect(settings.Release).toContain('CODE_SIGN_STYLE = Manual;');
    expect(settings.Release).toContain('CODE_SIGN_IDENTITY = "Apple Distribution: Acme Ltd (TEAM123456)";');
    expect(settings.Release).toContain('"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution: Acme Ltd (TEAM123456)";');
    expect(settings.Release).toContain('DEVELOPMENT_TEAM = TEAM123456;');
    expect(settings.Release).toContain('PROVISIONING_PROFILE_SPECIFIER = "Acme \\"Store\\" Profile";');
    expect(settings.Release).toContain('PRODUCT_BUNDLE_IDENTIFIER = "com.acme.app";');
    expect(settings.Debug).not.toContain('CODE_SIGN_STYLE');
    expect(settings.Debug).toContain('PRODUCT_BUNDLE_IDENTIFIER = "dev.rnworkflows.example";');

    // Project-level configurations (the ones without INFOPLIST_FILE) are untouched.
    expect(fs.readFileSync(pbxproj, 'utf8').match(/CODE_SIGN_STYLE/g)).toHaveLength(1);

    // Still a project Xcode's parser accepts, and patching twice is stable.
    const once = fs.readFileSync(pbxproj, 'utf8');
    patchXcodeProject(pbxproj, 7, { teamId: 'TEAM123456', profileName: 'Acme "Store" Profile', profileUuid: 'abc-123', identity: 'Apple Distribution: Acme Ltd (TEAM123456)', bundleId: 'com.acme.app' });
    expect(fs.readFileSync(pbxproj, 'utf8')).toBe(once);
  });

  it('keeps the app config bundle identifier for a wildcard profile', () => {
    const result = patchXcodeProject(pbxproj, 7, { teamId: 'T', profileName: 'Wild', profileUuid: 'u', identity: 'i', bundleId: null });
    expect(result.bundleId).toBe('dev.rnworkflows.example');
  });

  it('writes CFBundleVersion into Info.plist and leaves the rest alone', () => {
    const file = path.join(dir, 'Info.plist');
    fs.copyFileSync(path.join(fixtures, 'Info.plist'), file);
    const before = plist.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    patchInfoPlist(file, 1234);
    const after = plist.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(after.CFBundleVersion).toBe('1234');
    expect({ ...after, CFBundleVersion: before.CFBundleVersion }).toEqual(before);
  });
});

describe('security output parsing', () => {
  it('reads the keychain search list', () => {
    expect(parseKeychainList('    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/tmp/a b/x.keychain-db"\n')).toEqual([
      '/Users/runner/Library/Keychains/login.keychain-db',
      '/tmp/a b/x.keychain-db',
    ]);
    expect(parseKeychainList('')).toEqual([]);
  });

  it('reads the first identity, trusted or not', () => {
    const output = [
      'Policy: Code Signing',
      '  Matching identities',
      '  1) 4094C0DD50A6407A337F5493B6A94A73C5D686D0 "Apple Distribution: Acme Ltd (TEAM123456)" (CSSMERR_TP_NOT_TRUSTED)',
      '     1 identities found',
    ].join('\n');
    expect(parseIdentity(output)).toEqual({
      sha1: '4094c0dd50a6407a337f5493b6a94a73c5d686d0',
      name: 'Apple Distribution: Acme Ltd (TEAM123456)',
    });
    expect(parseIdentity('     0 identities found')).toBeNull();
  });
});

it('UserError subclasses keep their own name', () => {
  expect(new UserError('x').name).toBe('UserError');
});
