import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runResolve, toOutputs } from '../src/ci/resolve.js';
import { ConfigError, loadConfig, parseConfig } from '../src/config/load.js';
import { resolvePlan, type WorkflowInputs } from '../src/config/resolve.js';
import type { Config } from '../src/config/schema.js';

const config: Config = parseConfig({
  workingDirectory: 'mobile',
  buildNumberOffset: 100,
  runners: { android: 'BigRunner', ios: 'macos-15' },
  xcode: '16.4',
  artifacts: ['well-known/**'],
  profiles: {
    Dev: {
      android: { outputs: ['apk'] },
      deliver: { firebase: { groups: ['qa'] } },
    },
    PROD: {
      environment: 'Production',
      variant: 'production',
      deliver: { testflight: {}, play: { track: 'internal' } },
    },
  },
});

const resolve = (inputs: WorkflowInputs = {}, runNumber = 7, c: Config = config, hasConfigFile = true) =>
  resolvePlan({ config: c, hasConfigFile, inputs, runNumber });

describe('resolvePlan', () => {
  it('takes values from the config file when inputs are empty', () => {
    const plan = resolve({ profile: 'Dev', platform: '', iosRunner: '' });
    expect(plan).toMatchObject({
      profile: 'Dev',
      environment: 'Dev',
      signing: true,
      workingDirectory: 'mobile',
      buildNumber: 107,
      android: { enabled: true, runner: 'BigRunner', outputs: ['apk'] },
      ios: { enabled: true, runner: 'macos-15', xcode: '16.4' },
      deliver: { firebase: { groups: ['qa'] } },
      artifacts: ['well-known/**'],
      variant: null,
      cache: true,
    });
  });

  it('lets inputs override the config file', () => {
    const plan = resolve({
      profile: 'Dev',
      platform: 'ios',
      iosRunner: '["self-hosted","macOS"]',
      xcodeVersion: '26.0',
      workingDirectory: 'apps/mobile',
      buildNumberOffset: '0',
      artifactRetentionDays: '3',
    });
    expect(plan.android.enabled).toBe(false);
    expect(plan.ios).toEqual({ enabled: true, runner: ['self-hosted', 'macOS'], xcode: '26.0' });
    expect(plan.workingDirectory).toBe('apps/mobile');
    expect(plan.buildNumber).toBe(7);
    expect(plan.artifactRetentionDays).toBe(3);
  });

  it('caches by default, and lets the config file or an input turn it off', () => {
    expect(resolve({}).cache).toBe(true);
    expect(resolve({}, 7, { ...config, cache: false }).cache).toBe(false);
    expect(resolve({ cache: 'false' }).cache).toBe(false);
    expect(resolve({ cache: 'true' }, 7, { ...config, cache: false }).cache).toBe(true);
  });

  it('maps a profile to its own environment name and variant', () => {
    const plan = resolve({ profile: 'PROD' });
    expect(plan.environment).toBe('Production');
    expect(plan.variant).toEqual({ env: 'APP_VARIANT', value: 'production' });
    expect(plan.android.outputs).toEqual(['apk', 'aab']);
  });

  it('builds unsigned with no environment when no profile is given', () => {
    const plan = resolve({});
    expect(plan).toMatchObject({ profile: null, environment: null, signing: false, deliver: {} });
    expect(plan.android.outputs).toEqual(['apk']);
  });

  it('builds unsigned and drops delivery when signing is none', () => {
    const plan = resolve({ profile: 'Dev', signing: 'none' });
    expect(plan.signing).toBe(false);
    expect(plan.environment).toBeNull();
    expect(plan.deliver).toEqual({});
  });

  it('rejects a profile the config file does not define', () => {
    expect(() => resolve({ profile: 'UAT' })).toThrow(/Profile 'UAT' is not defined.*Dev, PROD/);
  });

  it('accepts any profile name when there is no config file', () => {
    const plan = resolve({ profile: 'UAT' }, 5, {}, false);
    expect(plan).toMatchObject({
      environment: 'UAT',
      signing: true,
      workingDirectory: '.',
      android: { runner: 'ubuntu-latest', outputs: ['apk', 'aab'] },
      ios: { runner: 'macos-latest', xcode: null },
      env: { vars: ['EXPO_PUBLIC_*'] },
    });
  });

  it('narrows delivery to the targets named in the input', () => {
    expect(resolve({ profile: 'PROD', deliver: 'testflight' }).deliver).toEqual({ testflight: {} });
    expect(resolve({ profile: 'PROD', deliver: 'none' }).deliver).toEqual({});
  });

  it('delivers a requested but unconfigured target with defaults', () => {
    expect(resolve({ profile: 'Dev', deliver: 'play, firebase' }).deliver).toEqual({
      firebase: { groups: ['qa'] },
      play: { track: 'internal', status: 'completed' },
    });
  });

  it('refuses to deliver an unsigned build', () => {
    expect(() => resolve({ deliver: 'firebase' })).toThrow(/Unsigned builds cannot be distributed/);
  });

  it('accepts submit-for-review only as false, since submission is not built yet', () => {
    expect(resolve({ profile: 'PROD', submitForReview: 'false' }).deliver.submitForReview).toBe(false);
    expect(() => resolve({ profile: 'PROD', submitForReview: 'true' })).toThrow(/not available yet/);
  });

  it.each([
    [{ platform: 'windows' }, /platform/],
    [{ signing: 'yes' }, /signing/],
    [{ profile: 'Dev', deliver: 'appcenter' }, /unknown target 'appcenter'/],
    [{ buildNumberOffset: 'ten' }, /build-number-offset/],
    [{ submitForReview: 'yes' }, /submit-for-review/],
    [{ iosRunner: '[1,2]' }, /ios-runner/],
    [{ buildNumberOffset: '-500' }, /positive integer/],
    [{ cache: 'off' }, /cache/],
  ] as [WorkflowInputs, RegExp][])('rejects invalid input %j', (inputs, message) => {
    expect(() => resolve(inputs)).toThrow(ConfigError);
    expect(() => resolve(inputs)).toThrow(message);
  });
});

describe('config file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnw-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is optional at the default path', () => {
    expect(loadConfig(dir)).toEqual({ config: {}, file: null });
  });

  it('must exist when a path is given explicitly', () => {
    expect(() => loadConfig(dir, 'ci/build.json')).toThrow(/not found/);
  });

  it('rejects unknown keys and malformed JSON', () => {
    fs.writeFileSync(path.join(dir, 'rn-workflows.json'), '{ "profile": {} }');
    expect(() => loadConfig(dir)).toThrow(/rn-workflows\.json is invalid/);
    fs.writeFileSync(path.join(dir, 'rn-workflows.json'), '{ nope');
    expect(() => loadConfig(dir)).toThrow(/not valid JSON/);
  });

  it('resolves end to end from env, reading the version from the app directory', () => {
    fs.mkdirSync(path.join(dir, 'mobile'));
    fs.writeFileSync(path.join(dir, 'mobile/app.json'), JSON.stringify({ expo: { version: '2.3.1' } }));
    fs.writeFileSync(
      path.join(dir, 'rn-workflows.json'),
      JSON.stringify({ workingDirectory: 'mobile', profiles: { Dev: {} } }),
    );

    const outputs = toOutputs(
      runResolve(dir, { INPUT_PROFILE: 'Dev', INPUT_PLATFORM: 'android', GITHUB_RUN_NUMBER: '42' }),
    );

    expect(outputs).toMatchObject({
      version: '2.3.1',
      'build-number': '42',
      environment: 'Dev',
      signing: 'true',
      android: 'true',
      ios: 'false',
      'android-runner': '"ubuntu-latest"',
      'working-directory': 'mobile',
      cache: 'true',
    });
    expect(JSON.parse(outputs.plan!).profile).toBe('Dev');
  });
});
