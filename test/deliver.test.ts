import { createVerify, generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverAndroid, deliverIos, releaseNotes, type Runner } from '../src/ci/deliver.js';
import { toOutputs } from '../src/ci/resolve.js';
import { deliveryStatus, runAscCredentials, runServiceAccountCredentials } from '../src/commands/delivery.js';
import { resolvePlan } from '../src/config/resolve.js';
import { parseConfig } from '../src/config/load.js';
import { altoolUploadArgs, ascToken, assignTestFlightGroups, validateAscKey } from '../src/deliver/asc.js';
import { androidFirebaseAppId, firebaseArgs, iosFirebaseAppId } from '../src/deliver/firebase.js';
import { googleAccessToken, parseServiceAccount } from '../src/deliver/google.js';
import { uploadToPlay } from '../src/deliver/play.js';
import { fakeGitHub } from './fake-github.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  type: 'service_account',
  client_email: 'ci@project.iam.gserviceaccount.com',
  private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
};
const serviceAccountB64 = Buffer.from(JSON.stringify(serviceAccount)).toString('base64');

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ascKey = {
  keyId: 'ABC123DEFG',
  issuerId: '69a6de70-03db-47e3-e053-5b8c7c11a4d1',
  privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
};

const decodeJwt = (token: string) => token.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p!, 'base64url').toString()));

interface Call {
  method: string;
  url: string;
  body?: any;
  headers: Record<string, string>;
}

/** A fetch that answers from a list of [matcher, response] routes and records every call. */
function fakeFetch(routes: [RegExp, (call: Call) => { status?: number; body?: unknown }][]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    let body: any = raw;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else if (raw instanceof Blob) {
      body = Buffer.from(await raw.arrayBuffer());
    }
    const call: Call = { method: init?.method ?? 'GET', url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(`${call.method} ${call.url}`));
    if (!route) return new Response(JSON.stringify({ error: { message: `unexpected ${call.method} ${call.url}` } }), { status: 500 });
    const { status = 200, body: responseBody } = route[1](call);
    return new Response(status === 204 ? null : JSON.stringify(responseBody ?? {}), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const tokenRoute: [RegExp, () => { body: unknown }] = [/POST https:\/\/oauth2\.googleapis\.com\/token/, () => ({ body: { access_token: 'ya29.token' } })];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnw-deliver-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Google service accounts', () => {
  it('rejects content that is not a service account key', () => {
    expect(() => parseServiceAccount('nope', 'X')).toThrow(/X is not JSON/);
    expect(() => parseServiceAccount('{"type":"authorized_user"}', 'X')).toThrow(/not a service account key/);
    expect(parseServiceAccount(JSON.stringify(serviceAccount), 'X').client_email).toBe(serviceAccount.client_email);
  });

  it('signs a JWT bearer assertion Google can verify', async () => {
    const { impl, calls } = fakeFetch([tokenRoute]);
    const at = new Date('2026-11-14T00:00:00Z');
    const iat = at.getTime() / 1000;
    const token = await googleAccessToken(serviceAccount, 'scope-a', impl, at);
    expect(token).toBe('ya29.token');

    const assertion = new URLSearchParams(calls[0]!.body as string).get('assertion')!;
    const [header, payload] = decodeJwt(assertion);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toEqual({ iss: serviceAccount.client_email, scope: 'scope-a', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 600 });
    const [h, p, signature] = assertion.split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(rsa.publicKey, signature!, 'base64url')).toBe(true);
  });

  it('explains a rejected key', async () => {
    const { impl } = fakeFetch([[/oauth2/, () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } })]]);
    await expect(googleAccessToken(serviceAccount, 's', impl)).rejects.toThrow(/rejected the service account ci@project.*Invalid JWT Signature/);
  });
});

describe('uploadToPlay', () => {
  const aab = () => {
    const file = path.join(dir, 'app.aab');
    fs.writeFileSync(file, 'bundle-bytes');
    return file;
  };

  it('uploads inside one edit and commits it', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      [/POST .*\/applications\/com\.acme\.app\/edits$/, () => ({ body: { id: 'edit1' } })],
      [/POST .*\/upload\/.*\/edits\/edit1\/bundles\?uploadType=media$/, () => ({ body: { versionCode: 245 } })],
      [/PUT .*\/edits\/edit1\/tracks\/internal$/, () => ({ body: {} })],
      [/POST .*\/edits\/edit1:commit$/, () => ({ body: {} })],
    ]);

    const result = await uploadToPlay({ account: serviceAccount, packageName: 'com.acme.app', aabPath: aab(), track: 'internal', status: 'completed', fetchImpl: impl });

    expect(result).toEqual({ versionCode: 245 });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /token',
      'POST /androidpublisher/v3/applications/com.acme.app/edits',
      'POST /upload/androidpublisher/v3/applications/com.acme.app/edits/edit1/bundles',
      'PUT /androidpublisher/v3/applications/com.acme.app/edits/edit1/tracks/internal',
      'POST /androidpublisher/v3/applications/com.acme.app/edits/edit1:commit',
    ]);
    expect(calls[2]!.body.toString()).toBe('bundle-bytes');
    expect(calls[2]!.headers.Authorization).toBe('Bearer ya29.token');
    expect(calls[3]!.body).toEqual({ track: 'internal', releases: [{ status: 'completed', versionCodes: ['245'] }] });
  });

  it('does not commit when a step fails, and says what to change', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      [/POST .*\/edits$/, () => ({ body: { id: 'edit1' } })],
      [/bundles/, () => ({ body: { versionCode: 7 } })],
      [/PUT .*\/tracks\//, () => ({ status: 400, body: { error: { message: 'Only releases with status draft may be created on draft app' } } })],
    ]);
    await expect(
      uploadToPlay({ account: serviceAccount, packageName: 'com.acme.app', aabPath: aab(), track: 'internal', status: 'completed', fetchImpl: impl }),
    ).rejects.toThrow(/assigning the track failed.*"status": "draft"/);
    expect(calls.some((c) => c.url.endsWith(':commit'))).toBe(false);
  });

  it('points at Play Console permissions when access is denied', async () => {
    const { impl } = fakeFetch([tokenRoute, [/edits$/, () => ({ status: 403, body: { error: { message: 'The caller does not have permission' } } })]]);
    await expect(
      uploadToPlay({ account: serviceAccount, packageName: 'com.acme.app', aabPath: aab(), track: 'internal', status: 'completed', fetchImpl: impl }),
    ).rejects.toThrow(/Invite ci@project\.iam\.gserviceaccount\.com in Play Console/);
  });
});

describe('Firebase', () => {
  it('finds the Android app ID for the package being built', () => {
    const client = (pkg: string, id: string) => ({ client_info: { mobilesdk_app_id: id, android_client_info: { package_name: pkg } } });
    fs.writeFileSync(path.join(dir, 'google-services.json'), JSON.stringify({ client: [client('com.acme.dev', '1:1:android:dev'), client('com.acme.app', '1:1:android:prod')] }));
    expect(androidFirebaseAppId(dir, 'com.acme.app')).toBe('1:1:android:prod');
    expect(androidFirebaseAppId(dir, 'com.other')).toBeNull();

    fs.writeFileSync(path.join(dir, 'google-services.json'), JSON.stringify({ client: [client('com.acme.dev', '1:1:android:dev')] }));
    expect(androidFirebaseAppId(dir, null)).toBe('1:1:android:dev');
    expect(androidFirebaseAppId(os.tmpdir(), 'x')).toBeNull();
  });

  it('finds the iOS app ID in GoogleService-Info.plist', () => {
    expect(iosFirebaseAppId(dir)).toBeNull();
    fs.writeFileSync(
      path.join(dir, 'GoogleService-Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>GOOGLE_APP_ID</key><string>1:1:ios:abc</string></dict></plist>',
    );
    expect(iosFirebaseAppId(dir)).toBe('1:1:ios:abc');
  });

  it('builds the firebase-tools command, with groups only when there are any', () => {
    expect(firebaseArgs({ file: 'a.apk', appId: '1:1:android:x', groups: ['qa', 'devs'], releaseNotes: 'notes' })).toEqual([
      '--yes', 'firebase-tools@15', 'appdistribution:distribute', 'a.apk', '--app', '1:1:android:x', '--release-notes', 'notes', '--groups', 'qa,devs',
    ]);
    expect(firebaseArgs({ file: 'a.apk', appId: 'x', groups: [], releaseNotes: 'n' })).not.toContain('--groups');
  });
});

describe('App Store Connect', () => {
  it('validates the key, key ID and issuer ID', () => {
    expect(validateAscKey(ascKey)).toEqual(ascKey);
    expect(() => validateAscKey({ ...ascKey, privateKey: 'AuthKey_ABC.p8' })).toThrow(/did not decode to a \.p8/);
    expect(() => validateAscKey({ ...ascKey, privateKey: serviceAccount.private_key })).toThrow(/not the key Apple issued/);
    expect(() => validateAscKey({ ...ascKey, keyId: 'AuthKey_ABC123DEFG.p8' })).toThrow(/KEY_ID should be the short ID/);
    expect(() => validateAscKey({ ...ascKey, issuerId: 'ABC123DEFG' })).toThrow(/ISSUER_ID should be the issuer UUID/);
  });

  it('signs tokens Apple can verify', () => {
    const at = new Date('2026-11-14T00:00:00Z');
    const iat = at.getTime() / 1000;
    const token = ascToken(ascKey, at);
    const [header, payload] = decodeJwt(token);
    expect(header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
    expect(payload).toEqual({ iss: ascKey.issuerId, iat, exp: iat + 900, aud: 'appstoreconnect-v1' });
    const [h, p, signature] = token.split('.');
    const raw = Buffer.from(signature!, 'base64url');
    expect(raw).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
  });

  it('passes the key to altool by ID, never by content', () => {
    const args = altoolUploadArgs('/tmp/app.ipa', ascKey);
    expect(args).toEqual(['altool', '--upload-app', '-t', 'ios', '-f', '/tmp/app.ipa', '--api-key', 'ABC123DEFG', '--api-issuer', ascKey.issuerId]);
  });

  const groupRoutes = (states: (string | null)[]) => {
    let poll = 0;
    return fakeFetch([
      [/GET .*\/v1\/apps\?/, () => ({ body: { data: [{ id: 'app1' }] } })],
      [/GET .*\/v1\/betaGroups\?/, () => ({ body: { data: [{ id: 'g1', attributes: { name: 'QA' } }, { id: 'g2', attributes: { name: 'Internal' } }] } })],
      [/GET .*\/v1\/builds\?/, () => {
        const state = states[Math.min(poll++, states.length - 1)];
        return { body: { data: state ? [{ id: 'build9', attributes: { processingState: state } }] : [] } };
      }],
      [/POST .*\/v1\/builds\/build9\/relationships\/betaGroups/, () => ({ status: 204 })],
    ]);
  };
  const assign = (fetchImpl: typeof fetch, extra = {}) =>
    assignTestFlightGroups({ key: ascKey, bundleId: 'com.acme.app', buildNumber: '245', version: '1.2.0', groups: ['QA', 'Internal'], fetchImpl, sleep: async () => {}, ...extra });

  it('waits for processing, then adds the build to the groups', async () => {
    const { impl, calls } = groupRoutes([null, 'PROCESSING', 'VALID']);
    const result = await assign(impl);

    expect(result).toEqual({ buildId: 'build9', groups: ['QA', 'Internal'] });
    const builds = calls.filter((c) => c.url.includes('/v1/builds?'));
    expect(builds).toHaveLength(3);
    const query = new URL(builds[0]!.url).searchParams;
    expect(query.get('filter[app]')).toBe('app1');
    expect(query.get('filter[version]')).toBe('245');
    expect(query.get('filter[preReleaseVersion.version]')).toBe('1.2.0');
    expect(calls.at(-1)!.body).toEqual({ data: [{ type: 'betaGroups', id: 'g1' }, { type: 'betaGroups', id: 'g2' }] });
  });

  it('fails clearly for an unknown group, a rejected build, and a timeout', async () => {
    await expect(assign(groupRoutes(['VALID']).impl, { groups: ['Beta'] })).rejects.toThrow(/no group named 'Beta'.*Existing groups: QA, Internal/);
    await expect(assign(groupRoutes(['INVALID']).impl)).rejects.toThrow(/Apple rejected build 245 during processing/);
    await expect(assign(groupRoutes(['PROCESSING']).impl, { timeoutMs: 0 })).rejects.toThrow(/was not ready after 0 minutes \(state PROCESSING\). It was uploaded/);
  });

  it('explains authentication failures', async () => {
    const { impl } = fakeFetch([[/apps/, () => ({ status: 401, body: { errors: [{ detail: 'Authentication credentials are missing or invalid.' }] } })]]);
    await expect(assign(impl)).rejects.toThrow(/do not belong together/);
  });
});

describe('plan', () => {
  const resolve = (config: unknown, inputs = {}) =>
    resolvePlan({ config: parseConfig(config), hasConfigFile: true, inputs: { profile: 'p', ...inputs }, runNumber: 1 });

  it('builds the format each store needs, whatever outputs say', () => {
    const plan = resolve({ profiles: { p: { android: { outputs: ['apk'] }, deliver: { play: {} } } } });
    expect(plan.android.outputs).toEqual(['apk', 'aab']);
    expect(plan.deliver.play).toEqual({ track: 'internal', status: 'completed' });
    expect(resolve({ profiles: { p: { android: { outputs: ['aab'] }, deliver: { firebase: {} } } } }).android.outputs).toEqual(['aab', 'apk']);
  });

  it('tells the workflow which delivery jobs to run', () => {
    const outputs = toOutputs({ plan: resolve({ profiles: { p: { deliver: { testflight: { groups: ['QA'] } } } } }), version: null });
    expect(outputs).toMatchObject({ 'android-deliver': 'false', 'ios-deliver': 'true', 'testflight-groups': 'true' });
    const none = toOutputs({ plan: resolve({ profiles: { p: { deliver: { firebase: {}, testflight: {} } } } }, { deliver: 'none' }), version: null });
    expect(none).toMatchObject({ 'android-deliver': 'false', 'ios-deliver': 'false', 'testflight-groups': 'false' });
  });

  it('refuses App Review submission until it exists', () => {
    expect(() => resolve({ profiles: { p: { deliver: { testflight: {}, submitForReview: true } } } })).toThrow(/not available yet/);
    expect(() => resolve({ profiles: { p: { deliver: { testflight: {} } } } }, { submitForReview: 'true' })).toThrow(/not available yet/);
    expect(resolve({ profiles: { p: { deliver: { testflight: {}, submitForReview: false } } } }).deliver.submitForReview).toBe(false);
  });
});

describe('deliver commands', () => {
  const plan = (deliver: object) =>
    resolvePlan({ config: parseConfig({ profiles: { p: { deliver } } }), hasConfigFile: true, inputs: { profile: 'p' }, runNumber: 77 });

  const recorder = () => {
    const runs: { command: string; args: string[]; env: NodeJS.ProcessEnv; keyFileContent?: string }[] = [];
    const uploads: any[] = [];
    const runner: Runner = {
      run(command, args, env) {
        const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS;
        runs.push({ command, args, env, keyFileContent: keyFile ? fs.readFileSync(keyFile, 'utf8') : undefined });
      },
      uploadToPlay: async (upload) => {
        uploads.push(upload);
        return { versionCode: 77 };
      },
    };
    return { runner, runs, uploads };
  };

  const androidApp = () => {
    const app = path.join(dir, 'app');
    fs.mkdirSync(path.join(app, 'android/app/build/outputs/apk/release'), { recursive: true });
    fs.mkdirSync(path.join(app, 'android/app/build/outputs/bundle/release'), { recursive: true });
    fs.writeFileSync(path.join(app, 'android/app/build.gradle'), "defaultConfig {\n  applicationId 'com.acme.app'\n  versionCode 77\n}");
    fs.writeFileSync(path.join(app, 'android/app/build/outputs/apk/release/app-release.apk'), 'apk');
    fs.writeFileSync(path.join(app, 'android/app/build/outputs/bundle/release/app-release.aab'), 'aab');
    fs.writeFileSync(
      path.join(app, 'google-services.json'),
      JSON.stringify({ client: [{ client_info: { mobilesdk_app_id: '1:1:android:x', android_client_info: { package_name: 'com.acme.app' } } }] }),
    );
    return app;
  };
  const scratch = () => path.join(dir, 'scratch');

  it('sends the APK to Firebase and the bundle to Play', async () => {
    const { runner, runs, uploads } = recorder();
    const app = androidApp();
    const report = await deliverAndroid(
      plan({ firebase: { groups: ['qa'] }, play: { track: 'beta', status: 'draft' } }),
      app,
      scratch(),
      { FIREBASE_SERVICE_ACCOUNT_BASE64: serviceAccountB64, GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64: serviceAccountB64, GITHUB_SHA: 'abcdef1234567' },
      runner,
    );

    expect(report).toEqual({ delivered: ['firebase', 'play'], skipped: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.command).toBe('npx');
    expect(runs[0]!.args.slice(0, 6)).toEqual(['--yes', 'firebase-tools@15', 'appdistribution:distribute', path.join(app, 'android/app/build/outputs/apk/release/app-release.apk'), '--app', '1:1:android:x']);
    expect(runs[0]!.args.slice(-2)).toEqual(['--groups', 'qa']);
    expect(runs[0]!.args[runs[0]!.args.indexOf('--release-notes') + 1]).toMatch(/\(abcdef1, build 77\)$/);
    expect(JSON.parse(runs[0]!.keyFileContent!).client_email).toBe(serviceAccount.client_email);
    expect(fs.statSync(runs[0]!.env.GOOGLE_APPLICATION_CREDENTIALS!).mode & 0o777).toBe(0o600);

    expect(uploads[0]).toMatchObject({ packageName: 'com.acme.app', track: 'beta', status: 'draft', aabPath: path.join(app, 'android/app/build/outputs/bundle/release/app-release.aab') });
  });

  it('skips a target whose secret is missing, and fails on a malformed one', async () => {
    const { runner, runs, uploads } = recorder();
    const report = await deliverAndroid(plan({ firebase: {}, play: {} }), androidApp(), scratch(), {}, runner);
    expect(report.delivered).toEqual([]);
    expect(report.skipped.map((s) => s.target)).toEqual(['firebase', 'play']);
    expect(report.skipped[0]!.reason).toMatch(/FIREBASE_SERVICE_ACCOUNT_BASE64 is not set/);
    expect(runs).toHaveLength(0);
    expect(uploads).toHaveLength(0);

    await expect(
      deliverAndroid(plan({ firebase: {} }), androidApp(), scratch(), { FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from('{"a":1}').toString('base64') }, runner),
    ).rejects.toThrow(/not a service account key/);
  });

  const iosApp = (profileBody: string) => {
    const app = path.join(dir, 'ios-app');
    fs.mkdirSync(path.join(app, 'ios/build/rnw'), { recursive: true });
    fs.writeFileSync(path.join(app, 'ios/build/rnw/App.ipa'), 'ipa');
    fs.writeFileSync(path.join(app, 'GoogleService-Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>GOOGLE_APP_ID</key><string>1:1:ios:abc</string></dict></plist>');
    const profilePath = path.join(dir, 'profile.mobileprovision');
    fs.writeFileSync(
      profilePath,
      `<?xml version="1.0"?><plist version="1.0"><dict><key>UUID</key><string>u</string><key>Name</key><string>n</string>
       <key>TeamIdentifier</key><array><string>T</string></array><key>ExpirationDate</key><date>2030-01-01T00:00:00Z</date>
       <key>Entitlements</key><dict><key>application-identifier</key><string>T.com.acme.app</string></dict>${profileBody}</dict></plist>`,
    );
    fs.mkdirSync(path.join(scratch(), 'ios'), { recursive: true });
    fs.writeFileSync(path.join(scratch(), 'ios', 'state.json'), JSON.stringify({ profilePath }));
    return app;
  };
  const ascEnv = {
    APP_STORE_CONNECT_API_KEY_ID: ascKey.keyId,
    APP_STORE_CONNECT_API_ISSUER_ID: ascKey.issuerId,
    APP_STORE_CONNECT_API_KEY_BASE64: Buffer.from(ascKey.privateKey).toString('base64'),
  };
  const adHoc = '<key>ProvisionedDevices</key><array><string>udid</string></array>';

  it('uploads an App Store build to TestFlight and keeps it away from Firebase', async () => {
    const { runner, runs } = recorder();
    const app = iosApp('');
    const report = await deliverIos(plan({ firebase: {}, testflight: {} }), app, scratch(), { ...ascEnv, FIREBASE_SERVICE_ACCOUNT_BASE64: serviceAccountB64 }, runner);

    expect(report.delivered).toEqual(['testflight']);
    expect(report.skipped).toEqual([{ target: 'firebase', reason: expect.stringMatching(/App Store build, which testers cannot install/) }]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.command).toBe('xcrun');
    expect(runs[0]!.args).toEqual(altoolUploadArgs(path.join(app, 'ios/build/rnw/App.ipa'), ascKey));
    const keyFile = path.join(runs[0]!.env.API_PRIVATE_KEYS_DIR!, 'AuthKey_ABC123DEFG.p8');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(ascKey.privateKey);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('sends an ad hoc build to Firebase and keeps it away from TestFlight', async () => {
    const { runner, runs } = recorder();
    const app = iosApp(adHoc);
    const report = await deliverIos(plan({ firebase: { groups: ['qa'] }, testflight: {} }), app, scratch(), { ...ascEnv, FIREBASE_SERVICE_ACCOUNT_BASE64: serviceAccountB64 }, runner);

    expect(report.delivered).toEqual(['firebase']);
    expect(report.skipped).toEqual([{ target: 'testflight', reason: expect.stringMatching(/profile is for release-testing/) }]);
    expect(runs[0]!.args.slice(2, 6)).toEqual(['appdistribution:distribute', path.join(app, 'ios/build/rnw/App.ipa'), '--app', '1:1:ios:abc']);
  });

  it('skips TestFlight when its secrets are incomplete', async () => {
    const { runner, runs } = recorder();
    const report = await deliverIos(plan({ testflight: {} }), iosApp(''), scratch(), { APP_STORE_CONNECT_API_KEY_ID: ascKey.keyId }, runner);
    expect(report.skipped[0]!.reason).toMatch(/APP_STORE_CONNECT_API_ISSUER_ID, APP_STORE_CONNECT_API_KEY_BASE64 are not set/);
    expect(runs).toHaveLength(0);
  });

  it('writes release notes that identify the build even without git', () => {
    expect(releaseNotes({ GITHUB_SHA: 'abcdef1234' }, 5, os.tmpdir())).toMatch(/\(abcdef1, build 5\)$/);
    expect(releaseNotes({}, 5, path.join(os.tmpdir(), 'does-not-exist'))).toBe('(build 5)');
  });
});

describe('delivery credentials commands', () => {
  it('stores a service account key and records whose it is', async () => {
    const fake = await fakeGitHub();
    const file = path.join(dir, 'key.json');
    fs.writeFileSync(file, JSON.stringify(serviceAccount));

    await runServiceAccountCredentials('play', { profile: 'PROD', serviceAccount: file }, fake.github, dir);
    await runServiceAccountCredentials('firebase', { profile: 'PROD', serviceAccount: file }, fake.github, dir);

    expect(Buffer.from(fake.secrets('PROD').GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64!, 'base64').toString()).toBe(JSON.stringify(serviceAccount));
    expect(fake.secrets('PROD').FIREBASE_SERVICE_ACCOUNT_BASE64).toBe(fake.secrets('PROD').GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64);
    expect(fake.variables('PROD')).toEqual({
      GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL: serviceAccount.client_email,
      FIREBASE_SERVICE_ACCOUNT_EMAIL: serviceAccount.client_email,
    });

    fs.writeFileSync(file, '{"type":"authorized_user"}');
    const before = JSON.stringify(fake.secrets('PROD'));
    await expect(runServiceAccountCredentials('play', { profile: 'PROD', serviceAccount: file }, fake.github, dir)).rejects.toThrow(/not a service account key/);
    expect(JSON.stringify(fake.secrets('PROD'))).toBe(before);
  });

  it('stores an App Store Connect key, reading the key ID from the file name', async () => {
    const fake = await fakeGitHub();
    const file = path.join(dir, 'AuthKey_ABC123DEFG.p8');
    fs.writeFileSync(file, ascKey.privateKey);

    await runAscCredentials({ profile: 'PROD', key: file, issuerId: ascKey.issuerId }, fake.github, dir);
    expect(fake.secrets('PROD')).toEqual({
      APP_STORE_CONNECT_API_KEY_ID: 'ABC123DEFG',
      APP_STORE_CONNECT_API_ISSUER_ID: ascKey.issuerId,
      APP_STORE_CONNECT_API_KEY_BASE64: Buffer.from(ascKey.privateKey).toString('base64'),
    });

    const renamed = path.join(dir, 'key.p8');
    fs.writeFileSync(renamed, ascKey.privateKey);
    await expect(runAscCredentials({ profile: 'PROD', key: renamed, issuerId: ascKey.issuerId }, fake.github, dir)).rejects.toThrow(/Pass --key-id/);
  });

  it('summarises delivery in status', () => {
    const secret = (name: string) => ({ name, updatedAt: '' });
    const variable = (name: string, value: string) => ({ name, value, updatedAt: '' });
    expect(deliveryStatus([], [])).toEqual({ line: 'no targets set up', problems: [] });
    expect(
      deliveryStatus(
        ['FIREBASE_SERVICE_ACCOUNT_BASE64', 'APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_API_ISSUER_ID', 'APP_STORE_CONNECT_API_KEY_BASE64'].map(secret),
        [variable('FIREBASE_SERVICE_ACCOUNT_EMAIL', 'ci@p.iam'), variable('APP_STORE_CONNECT_KEY_ID', 'ABC123DEFG')],
      ).line,
    ).toBe('firebase (ci@p.iam), testflight (key ABC123DEFG)');
    expect(deliveryStatus([secret('APP_STORE_CONNECT_API_KEY_ID')], [])).toEqual({
      line: 'no targets set up; INCOMPLETE: testflight is missing APP_STORE_CONNECT_API_ISSUER_ID, APP_STORE_CONNECT_API_KEY_BASE64',
      problems: ['testflight is missing APP_STORE_CONNECT_API_ISSUER_ID, APP_STORE_CONNECT_API_KEY_BASE64'],
    });
  });
});
