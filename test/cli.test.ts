import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectP12, reencodeForApple } from '../src/apple/p12.js';
import { generateKeystore, parseProperties, runAndroidCredentials } from '../src/commands/android.js';
import { buildConfig, callerWorkflow, findExpoApps, parseProfileNames, runInit } from '../src/commands/init.js';
import { runIosImport } from '../src/commands/ios.js';
import { ensureGitignored } from '../src/commands/shared.js';
import { platformStatus, runStatus } from '../src/commands/status.js';
import { parseConfig } from '../src/config/load.js';
import { GitHubError } from '../src/github/client.js';
import { parseRepo } from '../src/github/context.js';
import { WORKFLOW_SECRETS } from '../src/secrets.js';
import { fakeGitHub } from './fake-github.js';

const has = (command: string, args: string[]): boolean => {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const hasKeytool = has('keytool', ['-help']);
const hasOpenssl = has('openssl', ['version']);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnw-cli-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const logged = (): string => vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');

describe('parseRepo', () => {
  it.each([
    ['acme/app', 'acme', 'app'],
    ['https://github.com/acme/app.git', 'acme', 'app'],
    ['git@github.com:acme/my.app.git', 'acme', 'my.app'],
    ['ssh://git@github.com/acme/app/', 'acme', 'app'],
  ])('reads %s', (value, owner, name) => {
    expect(parseRepo(value)).toEqual({ owner, name });
  });

  it('rejects other hosts and shapes', () => {
    expect(parseRepo('https://gitlab.com/acme/app.git')).toBeNull();
    expect(parseRepo('app')).toBeNull();
  });
});

describe('GitHub client', () => {
  it('creates an environment only when it is missing', async () => {
    const fake = await fakeGitHub();
    expect(await fake.github.ensureEnvironment('Dev')).toEqual({ created: true });
    expect(await fake.github.ensureEnvironment('Dev')).toEqual({ created: false });
    expect(fake.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
  });

  it('seals secrets so that only the key holder can read them', async () => {
    const fake = await fakeGitHub();
    await fake.github.ensureEnvironment('my env');
    await fake.github.setSecrets('my env', { A: 'pä$$ word\n', B: '' });
    expect(fake.secrets('my env')).toEqual({ A: 'pä$$ word\n', B: '' });
    expect(fake.calls).toContain('PUT /repos/acme/app/environments/my%20env/secrets/A');
    expect((await fake.github.listSecrets('my env')).map((s) => s.name)).toEqual(['A', 'B']);
  });

  it('creates a variable, then updates it', async () => {
    const fake = await fakeGitHub();
    await fake.github.ensureEnvironment('Dev');
    await fake.github.setVariables('Dev', { X: '1' });
    await fake.github.setVariables('Dev', { X: '2' });
    expect(fake.variables('Dev')).toEqual({ X: '2' });
    expect(fake.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('explains permission failures', async () => {
    const fake = await fakeGitHub();
    const error = await fake.github.listSecrets('missing').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.status).toBe(404);
    expect(error.message).toMatch(/acme\/app exists and that your token can administer it/);
    await expect(fake.github.deleteSecret('missing', 'X')).resolves.toBeUndefined();
  });
});

describe('ensureGitignored', () => {
  it('adds the entry once, whatever form an existing line has', () => {
    expect(ensureGitignored(dir, '.credentials/')).toBe(true);
    expect(ensureGitignored(dir, '.credentials/')).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toMatch(/^# Signing credentials.*\n\.credentials\/\n$/);

    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n/.credentials');
    expect(ensureGitignored(dir, '.credentials/')).toBe(false);

    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules');
    expect(ensureGitignored(dir, '.credentials/')).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').startsWith('node_modules\n\n#')).toBe(true);
  });
});

describe('parseProperties', () => {
  it('reads signing properties files', () => {
    expect(parseProperties('# c\nstoreFile=release.keystore\nstorePassword = a=b\\:c\nkeyAlias: key0\n\n! x\n')).toEqual({
      storeFile: 'release.keystore',
      storePassword: 'a=b:c',
      keyAlias: 'key0',
    });
  });
});

describe.skipIf(!hasKeytool)('credentials android', () => {
  it('generates a keystore, keeps a private local copy, and uploads it', async () => {
    const fake = await fakeGitHub();
    await runAndroidCredentials({ profile: 'production', generate: true }, fake.github, dir);

    const local = path.join(dir, '.credentials', 'production', 'android');
    const props = parseProperties(fs.readFileSync(path.join(local, 'keystore.properties'), 'utf8'));
    expect(fs.statSync(path.join(local, 'upload.keystore')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(local, 'keystore.properties')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.credentials/');

    const secrets = fake.secrets('production');
    expect(Object.keys(secrets).sort()).toEqual(['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS']);
    expect(secrets.ANDROID_KEYSTORE_PASSWORD).toBe(props.storePassword);
    expect(secrets.ANDROID_KEY_ALIAS).toBe('upload');
    expect(Buffer.from(secrets.ANDROID_KEYSTORE_BASE64!, 'base64').equals(fs.readFileSync(path.join(local, 'upload.keystore')))).toBe(true);
    expect(fake.variables('production').ANDROID_CERT_SHA256).toBe(props.certSha256);
    expect(logged()).toMatch(/IMPORTANT: copy both files to your password manager/);
    // The password is on disk for the user, never in the terminal output.
    expect(logged()).not.toContain(props.storePassword!);
  });

  it('refuses to replace an existing keystore without --force', async () => {
    const fake = await fakeGitHub();
    await runAndroidCredentials({ profile: 'production', generate: true }, fake.github, dir);
    const first = fake.secrets('production').ANDROID_KEYSTORE_BASE64;

    await expect(runAndroidCredentials({ profile: 'production', generate: true }, fake.github, dir)).rejects.toThrow(
      /already has an Android keystore.*--force/,
    );
    expect(fake.secrets('production').ANDROID_KEYSTORE_BASE64).toBe(first);
  });

  it('imports from a signing properties file and drops a stale key password', async () => {
    const source = generateKeystore(path.join(dir, 'src'), 'test') ;
    const fake = await fakeGitHub();
    await fake.github.ensureEnvironment('Dev');
    await fake.github.setSecrets('Dev', { ANDROID_KEY_PASSWORD: 'from-an-older-keystore' });

    await runAndroidCredentials({ profile: 'Dev', properties: source.propertiesPath }, fake.github, dir);

    expect(fake.secrets('Dev')).toEqual({
      ANDROID_KEYSTORE_BASE64: source.keystore.toString('base64'),
      ANDROID_KEYSTORE_PASSWORD: source.keystorePassword,
      ANDROID_KEY_ALIAS: 'upload',
    });
    expect(fake.variables('Dev').ANDROID_CERT_SHA256).toBe(source.certSha256);
  });

  it('uploads nothing when the password is wrong', async () => {
    const source = generateKeystore(path.join(dir, 'src'), 'test');
    const fake = await fakeGitHub();
    await expect(
      runAndroidCredentials({ profile: 'Dev', keystore: source.keystorePath, alias: 'upload', keystorePassword: 'nope' }, fake.github, dir),
    ).rejects.toThrow(/did not open/);
    expect(fake.environments.size).toBe(0);
  });

  it('requires a choice between generating and importing', async () => {
    const fake = await fakeGitHub();
    await expect(runAndroidCredentials({ profile: 'Dev' }, fake.github, dir)).rejects.toThrow(/--generate.*--keystore/);
    await expect(runAndroidCredentials({ profile: 'Dev', generate: true, keystore: 'x' }, fake.github, dir)).rejects.toThrow(/Choose one/);
  });
});

describe.skipIf(!hasOpenssl)('credentials ios', () => {
  let creds: string;
  let other: string;
  const script = path.resolve(import.meta.dirname, '../scripts/make-fake-ios-credentials.sh');
  const credsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rnw-ios-creds-'));

  beforeAll(() => {
    creds = path.join(credsRoot, 'a');
    other = path.join(credsRoot, 'b');
    execFileSync(script, [creds, 'com.acme.app']);
    execFileSync(script, [other, 'com.acme.app']);
    return () => fs.rmSync(credsRoot, { recursive: true, force: true });
  });

  const p12 = () => path.join(creds, 'certificate.p12');
  const profile = () => path.join(creds, 'profile.mobileprovision');

  it('describes a .p12 and rejects a wrong password or a bare certificate', () => {
    const info = inspectP12(p12(), 'fake-password');
    expect(info).toMatchObject({ commonName: 'Apple Distribution: rn-workflows Fake (FAKETEAM01)', appleCompatible: true });
    expect(info.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(() => inspectP12(p12(), 'wrong')).toThrow(/password is wrong/);
    expect(() => inspectP12(path.join(creds, 'cert.pem'), 'fake-password')).toThrow(/could not be opened/);
  });

  it('converts a .p12 written with modern encryption into the form macOS imports', () => {
    // What `openssl pkcs12 -export` produces by default on OpenSSL 3.
    const modern = path.join(dir, 'modern.p12');
    const pem = path.join(dir, 'all.pem');
    execFileSync('openssl', ['pkcs12', '-in', p12(), '-nodes', '-out', pem, '-passin', 'pass:fake-password']);
    execFileSync('openssl', ['pkcs12', '-export', '-inkey', pem, '-in', pem, '-out', modern, '-passout', 'pass:fake-password']);

    const before = inspectP12(modern, 'fake-password');
    // OpenSSL 3 writes AES by default; older builds write the old format and need no conversion.
    const opensslMajor = Number(/^OpenSSL (\d+)/.exec(execFileSync('openssl', ['version'], { encoding: 'utf8' }))?.[1] ?? 0);
    if (opensslMajor >= 3) expect(before.appleCompatible).toBe(false);
    if (before.appleCompatible) return;

    const converted = path.join(dir, 'converted.p12');
    fs.writeFileSync(converted, reencodeForApple(modern, 'fake-password', before.needsLegacyFlag));
    const after = inspectP12(converted, 'fake-password');
    expect(after.appleCompatible).toBe(true);
    expect(after.sha1).toBe(before.sha1);
  });

  it('uploads a certificate and profile together and records what they are', async () => {
    const fake = await fakeGitHub();
    await runIosImport({ profile: 'PROD', p12: p12(), p12Password: 'fake-password', mobileprovision: profile() }, fake.github, dir);

    const secrets = fake.secrets('PROD');
    expect(Object.keys(secrets).sort()).toEqual(['IOS_MOBILEPROVISION_BASE64', 'IOS_P12_BASE64', 'IOS_P12_PASSWORD']);
    expect(Buffer.from(secrets.IOS_MOBILEPROVISION_BASE64!, 'base64').equals(fs.readFileSync(profile()))).toBe(true);
    expect(secrets.IOS_P12_PASSWORD).toBe('fake-password');
    expect(fake.variables('PROD')).toMatchObject({
      IOS_CERT_NAME: 'Apple Distribution: rn-workflows Fake (FAKETEAM01)',
      IOS_PROFILE_NAME: 'rn-workflows Fake Ad Hoc',
      IOS_BUNDLE_ID: 'com.acme.app',
      IOS_TEAM_ID: 'FAKETEAM01',
      IOS_EXPORT_METHOD: 'release-testing',
    });
    expect(fake.variables('PROD').IOS_PROFILE_EXPIRES).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(logged()).not.toContain('fake-password');
  });

  it('accepts a renewed profile alone when it matches the certificate on record', async () => {
    const fake = await fakeGitHub();
    await runIosImport({ profile: 'PROD', p12: p12(), p12Password: 'fake-password', mobileprovision: profile() }, fake.github, dir);
    const p12Before = fake.secrets('PROD').IOS_P12_BASE64;

    await runIosImport({ profile: 'PROD', mobileprovision: profile() }, fake.github, dir);
    expect(fake.secrets('PROD').IOS_P12_BASE64).toBe(p12Before);
  });

  it('rejects a profile made for a different certificate, uploading nothing', async () => {
    const fake = await fakeGitHub();
    await runIosImport({ profile: 'PROD', p12: p12(), p12Password: 'fake-password', mobileprovision: profile() }, fake.github, dir);
    const before = JSON.stringify([fake.secrets('PROD'), fake.variables('PROD')]);

    const foreign = path.join(other, 'profile.mobileprovision');
    await expect(runIosImport({ profile: 'PROD', mobileprovision: foreign }, fake.github, dir)).rejects.toThrow(
      /does not include the certificate.*Nothing was uploaded/,
    );
    await expect(
      runIosImport({ profile: 'PROD', p12: path.join(other, 'certificate.p12'), p12Password: 'fake-password', mobileprovision: profile() }, fake.github, dir),
    ).rejects.toThrow(/does not include the certificate/);
    expect(JSON.stringify([fake.secrets('PROD'), fake.variables('PROD')])).toBe(before);
  });
});

describe('status', () => {
  const secret = (name: string) => ({ name, updatedAt: '2026-11-01T08:00:00Z' });
  const variable = (name: string, value: string) => ({ name, value, updatedAt: '2026-11-01T08:00:00Z' });
  const now = new Date('2026-11-14T12:00:00Z');

  it('reports ready, incomplete and absent setups', () => {
    const android = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS'].map(secret);
    expect(platformStatus('android', android, [variable('ANDROID_CERT_SHA256', 'abc')], now)).toMatchObject({
      state: 'ready',
      problems: [],
      lines: ['ready, secrets last updated 2026-11-01', 'certificate SHA-256 abc'],
    });
    expect(platformStatus('android', android.slice(0, 2), [], now)).toMatchObject({
      state: 'partial',
      missing: ['ANDROID_KEY_ALIAS'],
      problems: ['missing ANDROID_KEY_ALIAS'],
    });
    expect(platformStatus('ios', android, [], now)).toMatchObject({ state: 'none', lines: ['not set up'], problems: [] });
  });

  it('flags expiry for iOS', () => {
    const ios = ['IOS_P12_BASE64', 'IOS_P12_PASSWORD', 'IOS_MOBILEPROVISION_BASE64'].map(secret);
    const status = platformStatus(
      'ios',
      ios,
      [
        variable('IOS_CERT_NAME', 'Apple Distribution: Acme'),
        variable('IOS_PROFILE_NAME', 'Acme Store'),
        variable('IOS_BUNDLE_ID', 'com.acme.app'),
        variable('IOS_EXPORT_METHOD', 'app-store-connect'),
        variable('IOS_CERT_EXPIRES', '2026-12-01'),
        variable('IOS_PROFILE_EXPIRES', '2026-11-10'),
      ],
      now,
    );
    expect(status.lines).toEqual([
      'ready, secrets last updated 2026-11-01',
      'certificate Apple Distribution: Acme',
      "profile 'Acme Store' for com.acme.app (app-store-connect)",
      'certificate expires 2026-12-01 (in 16 days, renew soon)',
      'profile EXPIRED on 2026-11-10',
    ]);
    expect(status.problems).toEqual(['profile expired on 2026-11-10']);
  });

  it('prints every profile in the config file and counts problems', async () => {
    fs.writeFileSync(path.join(dir, 'rn-workflows.json'), JSON.stringify({ profiles: { Dev: {}, PROD: { environment: 'Production' } } }));
    const fake = await fakeGitHub();
    await fake.github.ensureEnvironment('Dev');
    await fake.github.setSecrets('Dev', { ANDROID_KEYSTORE_BASE64: 'x' });

    expect(await runStatus({}, fake.github, dir)).toBe(1);
    expect(logged()).toContain('Profile Dev\n  Android INCOMPLETE, missing ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS\n  iOS     not set up');
    expect(logged()).toContain('Profile PROD (environment Production)\n  environment does not exist yet');
  });
});

describe('init', () => {
  const expoApp = (relative: string) => {
    fs.mkdirSync(path.join(dir, relative), { recursive: true });
    fs.writeFileSync(path.join(dir, relative, 'app.json'), JSON.stringify({ expo: { name: 'x' } }));
  };

  it('finds Expo apps at the root or in a workspace, ignoring build output', () => {
    expect(findExpoApps(dir)).toEqual([]);
    expoApp('mobile');
    expoApp('node_modules/some-package');
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'app.json'), '{"name":"not expo"}');
    fs.mkdirSync(path.join(dir, 'apps', 'client'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps', 'client', 'app.config.ts'), '');
    expect(findExpoApps(dir)).toEqual(['apps/client', 'mobile']);

    expoApp('.');
    expect(findExpoApps(dir)).toEqual(['.']);
  });

  it('validates profile names', () => {
    expect(parseProfileNames(' Dev, UAT ,Dev,')).toEqual(['Dev', 'UAT']);
    expect(() => parseProfileNames(' , ')).toThrow(/At least one/);
    expect(() => parseProfileNames('prod/eu')).toThrow(/not a usable profile name/);
  });

  it('builds a config the schema accepts and keeps what was already there', () => {
    const config = buildConfig('mobile', ['Dev', 'PROD'], { xcode: '16.4', profiles: { PROD: { variant: 'production' } } });
    expect(parseConfig(config)).toMatchObject({
      workingDirectory: 'mobile',
      xcode: '16.4',
      profiles: { Dev: {}, PROD: { variant: 'production' } },
    });
    expect(buildConfig('.', ['a'])).not.toHaveProperty('workingDirectory');
  });

  it('scaffolds a caller that passes every secret the workflow declares', () => {
    const workflow = callerWorkflow(['Dev', "it's"]);
    expect(workflow).toContain('uses: lmiklosko/rn-workflows/.github/workflows/build.yml@main');
    expect(workflow).toContain("          - 'it''s'");
    expect(workflow).not.toContain('secrets: inherit\n');
    for (const name of WORKFLOW_SECRETS) {
      expect(workflow).toContain(`      ${name}: \${{ secrets.${name} }}`);
    }

    const buildYml = fs.readFileSync(path.resolve(import.meta.dirname, '../.github/workflows/build.yml'), 'utf8');
    const declared = [...buildYml.split('\n    secrets:\n')[1]!.split('\n    outputs:')[0]!.matchAll(/^      ([A-Z0-9_]+):$/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...WORKFLOW_SECRETS].sort());
  });

  it('sets up files and environments without prompting', async () => {
    expoApp('mobile');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    const fake = await fakeGitHub();

    await runInit({ yes: true, profiles: 'Dev,PROD' }, fake.github, dir);

    expect(parseConfig(JSON.parse(fs.readFileSync(path.join(dir, 'rn-workflows.json'), 'utf8')))).toMatchObject({
      workingDirectory: 'mobile',
      profiles: { Dev: {}, PROD: {} },
    });
    expect(fs.readFileSync(path.join(dir, '.github/workflows/mobile-build.yml'), 'utf8')).toContain("default: 'Dev'");
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.credentials/');
    expect([...fake.environments.keys()]).toEqual(['Dev', 'PROD']);

    // Running it again changes nothing that exists.
    fs.writeFileSync(path.join(dir, '.github/workflows/mobile-build.yml'), 'mine');
    await runInit({ yes: true }, fake.github, dir);
    expect(fs.readFileSync(path.join(dir, '.github/workflows/mobile-build.yml'), 'utf8')).toBe('mine');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'rn-workflows.json'), 'utf8')).profiles)).toEqual(['Dev', 'PROD']);
  });

  it('says so when there is no Expo app', async () => {
    const fake = await fakeGitHub();
    await expect(runInit({ yes: true }, fake.github, dir)).rejects.toThrow(/No Expo app found/);
  });
});
