import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatKeyValue } from '../src/ci/actions.js';
import {
  decodeBase64Strict,
  escapeProperty,
  installAndroidCredentials,
  patchVersionCode,
  removeAndroidCredentials,
  stripSigningBlock,
  withSigningBlock,
} from '../src/ci/android.js';
import { collectEnv, parseDotenv } from '../src/ci/env.js';
import { androidGradleTasks, toOutputs } from '../src/ci/resolve.js';
import { resolvePlan } from '../src/config/resolve.js';
import type { Config } from '../src/config/schema.js';
import { UserError } from '../src/errors.js';

const plan = (config: Config = {}, inputs = {}) =>
  resolvePlan({ config: { profiles: { Dev: {} }, ...config }, hasConfigFile: true, inputs: { profile: 'Dev', ...inputs }, runNumber: 31 });

describe('formatKeyValue', () => {
  it('writes single-line values plainly and multi-line values as a heredoc', () => {
    expect(formatKeyValue('a', 'b')).toBe('a=b\n');
    const [head, ...rest] = formatKeyValue('a', 'x\ny').trimEnd().split('\n');
    const delimiter = head!.slice('a<<'.length);
    expect(rest).toEqual(['x', 'y', delimiter]);
    expect(delimiter).toMatch(/^rnw_[0-9a-f-]{36}$/);
  });
});

describe('parseDotenv', () => {
  it('handles comments, export, quotes and escapes', () => {
    expect(
      parseDotenv(
        ['# comment', '', 'A=1', 'export B = two words # trailing', 'C="line\\nbreak # kept"', "D='raw \\n'", 'E=', 'F=a=b'].join('\r\n'),
      ),
    ).toEqual({ A: '1', B: 'two words', C: 'line\nbreak # kept', D: 'raw \\n', E: '', F: 'a=b' });
  });

  it('reports the line number, not the content, of a malformed line', () => {
    expect(() => parseDotenv('A=1\nhunter2')).toThrow(/^APP_ENV line 2 is not in KEY=value form\.$/);
  });
});

describe('collectEnv', () => {
  const byName = (entries: ReturnType<typeof collectEnv>) => Object.fromEntries(entries.map((e) => [e.name, e]));

  it('exposes matching variables, APP_ENV, the variant and the build number', () => {
    const entries = byName(
      collectEnv({
        plan: plan({ profiles: { Dev: { variant: 'staging' } }, env: { vars: ['EXPO_PUBLIC_*', 'SENTRY_ORG'] } }),
        vars: { EXPO_PUBLIC_API: 'https://api', SENTRY_ORG: 'acme', AWS_ROLE: 'arn', XEXPO_PUBLIC_NOPE: '1' },
        appEnv: 'EXPO_PUBLIC_API=https://override\nSENTRY_AUTH_TOKEN=abc',
      }),
    );
    expect(Object.keys(entries).sort()).toEqual(
      ['APP_VARIANT', 'EXPO_PUBLIC_API', 'RNW_BUILD_NUMBER', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG'].sort(),
    );
    expect(entries.EXPO_PUBLIC_API).toEqual({ name: 'EXPO_PUBLIC_API', value: 'https://override', secret: true });
    expect(entries.SENTRY_ORG!.secret).toBe(false);
    expect(entries.APP_VARIANT!.value).toBe('staging');
    expect(entries.RNW_BUILD_NUMBER!.value).toBe('31');
  });

  it('refuses names that would change the runner or toolchain', () => {
    expect(() => collectEnv({ plan: plan(), vars: {}, appEnv: 'PATH=/tmp' })).toThrow(/'PATH', which is reserved/);
    expect(() => collectEnv({ plan: plan(), vars: {}, appEnv: 'GITHUB_TOKEN=x' })).toThrow(/reserved/);
    expect(() => collectEnv({ plan: plan({ env: { vars: ['*'] } }), vars: { NODE_OPTIONS: '-r x' } })).toThrow(/reserved/);
    expect(() => collectEnv({ plan: plan(), vars: {}, appEnv: 'MY-KEY=x' })).toThrow(/not a valid environment variable name/);
  });
});

describe('Android build outputs', () => {
  it('chooses Gradle tasks from the plan', () => {
    expect(androidGradleTasks(plan())).toEqual(['assembleRelease', 'bundleRelease']);
    expect(androidGradleTasks(plan({ profiles: { Dev: { android: { outputs: ['aab'] } } } }))).toEqual(['bundleRelease']);
    expect(androidGradleTasks(plan({}, { signing: 'none' }))).toEqual(['assembleDebug']);
  });

  it('prefixes extra artifact globs with the working directory', () => {
    const outputs = toOutputs({ plan: plan({ workingDirectory: 'mobile/', artifacts: ['well-known/**', 'a.txt'] }), version: null });
    expect(outputs['working-directory']).toBe('mobile');
    expect(outputs['extra-artifact-paths']).toBe('mobile/well-known/**\nmobile/a.txt');
    expect(outputs['android-gradle-tasks']).toBe('assembleRelease bundleRelease');
  });
});

describe('patchVersionCode', () => {
  it('replaces the value in Groovy and Kotlin scripts and nothing else', () => {
    const groovy = 'defaultConfig {\n    versionCode 1\n    versionName "1.0.0"\n}';
    expect(patchVersionCode(groovy, 245)).toBe('defaultConfig {\n    versionCode 245\n    versionName "1.0.0"\n}');
    expect(patchVersionCode('versionCode = 7\nversionCode = 9', 3)).toBe('versionCode = 3\nversionCode = 9');
  });

  it('fails when there is nothing to patch or the number is out of range', () => {
    expect(() => patchVersionCode('versionCode project.ext.code', 3)).toThrow(/Could not find a numeric versionCode/);
    expect(() => patchVersionCode('versionCode 1', 0)).toThrow(UserError);
    expect(() => patchVersionCode('versionCode 1', 2_100_000_001)).toThrow(UserError);
  });
});

describe('gradle.properties signing block', () => {
  it('escapes values the way java.util.Properties reads them', () => {
    expect(escapeProperty('C:\\keys\\a b')).toBe('C:\\\\keys\\\\a b');
    expect(escapeProperty(' lead#ing=x!')).toBe('\\ lead#ing=x!');
    expect(escapeProperty('pä\n')).toBe('p\\u00e4\\n');
  });

  it('adds, replaces and removes its block without touching the rest', () => {
    const original = 'org.gradle.jvmargs=-Xmx4g';
    const once = withSigningBlock(original, { a: '1' });
    const twice = withSigningBlock(once, { a: '2' });
    expect(twice).toContain('org.gradle.jvmargs=-Xmx4g\n');
    expect(twice).toContain('a=2');
    expect(twice).not.toContain('a=1');
    expect(stripSigningBlock(twice)).toBe('org.gradle.jvmargs=-Xmx4g\n');
    expect(stripSigningBlock(original)).toBe(original);
  });
});

describe('decodeBase64Strict', () => {
  it('accepts wrapped base64 and rejects anything else', () => {
    expect(decodeBase64Strict('aGVs\nbG8=\n', 'X').toString()).toBe('hello');
    expect(() => decodeBase64Strict('release.keystore', 'ANDROID_KEYSTORE_BASE64')).toThrow(/ANDROID_KEYSTORE_BASE64 is not valid base64/);
    expect(() => decodeBase64Strict('', 'X')).toThrow(UserError);
  });
});

const hasKeytool = (() => {
  try {
    execFileSync('keytool', ['-help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasKeytool)('installAndroidCredentials', () => {
  let dir: string;
  let keystoreBase64: string;
  let propertiesFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnw-android-'));
    const source = path.join(dir, 'source.keystore');
    execFileSync(
      'keytool',
      ['-genkeypair', '-storetype', 'PKCS12', '-keystore', source, '-alias', 'upload', '-keyalg', 'RSA', '-keysize', '2048',
        '-validity', '1', '-storepass', 'store-pass', '-keypass', 'store-pass', '-dname', 'CN=test'],
      { stdio: 'ignore' },
    );
    keystoreBase64 = fs.readFileSync(source).toString('base64');
    propertiesFile = path.join(dir, 'gradle-home', 'gradle.properties');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const install = (overrides = {}) =>
    installAndroidCredentials(
      { keystoreBase64, keystorePassword: 'store-pass', keyAlias: 'upload', ...overrides },
      path.join(dir, 'out'),
      propertiesFile,
    );

  it('writes the keystore and Gradle properties, then removes them', () => {
    const result = install();
    expect(result.certSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(result.keystorePath).mode & 0o777).toBe(0o600);

    const properties = fs.readFileSync(propertiesFile, 'utf8');
    expect(properties).toContain(`android.injected.signing.store.file=${result.keystorePath}`);
    expect(properties).toContain('android.injected.signing.key.alias=upload');
    expect(properties).toContain('android.injected.signing.key.password=store-pass');

    removeAndroidCredentials(propertiesFile);
    expect(fs.existsSync(propertiesFile)).toBe(false);
  });

  it('names the secret that is wrong', () => {
    expect(() => install({ keystorePassword: 'nope' })).toThrow(/did not open with ANDROID_KEYSTORE_PASSWORD/);
    expect(() => install({ keyAlias: 'key0' })).toThrow(/no key with alias 'key0'.*It contains: upload\./);
    expect(() => install({ keystoreBase64: '', keyAlias: ' ' })).toThrow(
      /needs ANDROID_KEYSTORE_BASE64, ANDROID_KEY_ALIAS, which are empty/,
    );
    expect(fs.existsSync(propertiesFile)).toBe(false);
  });
});
