import { createPrivateKey, sign } from 'node:crypto';
import { UserError } from '../errors.js';
import { base64url } from './google.js';

const API = 'https://api.appstoreconnect.apple.com';

export interface AscKey {
  keyId: string;
  issuerId: string;
  /** The .p8 file's content. */
  privateKey: string;
}

/** Checks the three App Store Connect values fit together as far as can be told offline. */
export function validateAscKey(key: Partial<AscKey>): AscKey {
  const keyId = key.keyId?.trim() ?? '';
  const issuerId = key.issuerId?.trim() ?? '';
  const privateKey = key.privateKey ?? '';

  if (!/BEGIN PRIVATE KEY/.test(privateKey)) {
    throw new UserError(
      "APP_STORE_CONNECT_API_KEY_BASE64 did not decode to a .p8 private key. Encode the file with: base64 -i AuthKey_XXXX.p8 | tr -d '\\n'",
    );
  }
  try {
    const parsed = createPrivateKey(privateKey);
    if (parsed.asymmetricKeyType !== 'ec') throw new Error('not an EC key');
  } catch {
    throw new UserError('The App Store Connect .p8 key is damaged or is not the key Apple issued (an EC private key).');
  }
  if (!/^[A-Z0-9]{8,12}$/.test(keyId)) {
    throw new UserError(`APP_STORE_CONNECT_API_KEY_ID should be the short ID from the key's file name (AuthKey_<ID>.p8), got '${keyId}'.`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issuerId)) {
    throw new UserError('APP_STORE_CONNECT_API_ISSUER_ID should be the issuer UUID shown on the Users and Access > Integrations page.');
  }
  return { keyId, issuerId, privateKey };
}

export function ascToken(key: AscKey, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned =
    base64url(JSON.stringify({ alg: 'ES256', kid: key.keyId, typ: 'JWT' })) +
    '.' +
    base64url(JSON.stringify({ iss: key.issuerId, iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1' }));
  // JWTs carry the raw r||s signature, not the DER form Node produces by default.
  const signature = sign('sha256', Buffer.from(unsigned), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${base64url(signature)}`;
}

/** Arguments for `xcrun altool`. The key itself is found through API_PRIVATE_KEYS_DIR. */
export const altoolUploadArgs = (ipa: string, key: AscKey): string[] => [
  'altool',
  '--upload-app',
  '-t',
  'ios',
  '-f',
  ipa,
  '--api-key',
  key.keyId,
  '--api-issuer',
  key.issuerId,
];

export interface GroupAssignment {
  key: AscKey;
  bundleId: string;
  /** CFBundleVersion of the uploaded build. */
  buildNumber: string;
  /** Marketing version, to tell apart equal build numbers across versions. */
  version: string | null;
  groups: string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for Apple to finish processing the build. */
  timeoutMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
}

/**
 * Adds an uploaded build to TestFlight groups. A build can only be assigned
 * once Apple has processed it, which takes minutes, so this polls until it is
 * ready.
 */
export async function assignTestFlightGroups(options: GroupAssignment): Promise<{ buildId: string; groups: string[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 40 * 60 * 1000;
  const pollMs = options.pollMs ?? 30 * 1000;

  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    // A fresh token per call: the wait below can outlive a token's 15 minutes.
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ascToken(options.key)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.errors?.[0]?.detail ?? data?.errors?.[0]?.title ?? response.status;
      const hint =
        response.status === 401
          ? ' The key ID, issuer ID and .p8 do not belong together, or the key was revoked.'
          : response.status === 403
            ? ' The API key needs the App Manager role (or higher) to manage TestFlight.'
            : '';
      throw new UserError(`App Store Connect: ${method} ${path.split('?')[0]} failed: ${detail}.${hint}`);
    }
    return data;
  };
  const q = (params: Record<string, string>): string => new URLSearchParams(params).toString();

  const apps = await call('GET', `/v1/apps?${q({ 'filter[bundleId]': options.bundleId, limit: '1' })}`);
  const appId: string | undefined = apps.data?.[0]?.id;
  if (!appId) {
    throw new UserError(`App Store Connect has no app with bundle ID ${options.bundleId} that this API key can see.`);
  }

  const wanted = [...new Set(options.groups)];
  const groupIds: string[] = [];
  const allGroups = await call('GET', `/v1/betaGroups?${q({ 'filter[app]': appId, limit: '200' })}`);
  for (const name of wanted) {
    const group = (allGroups.data ?? []).find((g: any) => g.attributes?.name === name);
    if (!group) {
      const known = (allGroups.data ?? []).map((g: any) => g.attributes?.name).join(', ');
      throw new UserError(`TestFlight has no group named '${name}' for this app.${known ? ` Existing groups: ${known}.` : ''}`);
    }
    groupIds.push(group.id);
  }

  const buildQuery = q({
    'filter[app]': appId,
    'filter[version]': options.buildNumber,
    ...(options.version ? { 'filter[preReleaseVersion.version]': options.version } : {}),
    limit: '1',
  });
  const deadline = Date.now() + timeoutMs;
  let buildId: string | undefined;
  for (;;) {
    const builds = await call('GET', `/v1/builds?${buildQuery}`);
    const build = builds.data?.[0];
    const state: string | undefined = build?.attributes?.processingState;
    if (state === 'VALID') {
      buildId = build.id;
      break;
    }
    if (state === 'FAILED' || state === 'INVALID') {
      throw new UserError(`Apple rejected build ${options.buildNumber} during processing (state ${state}). Check the email Apple sent to the team.`);
    }
    if (Date.now() >= deadline) {
      throw new UserError(
        `Build ${options.buildNumber} was not ready after ${Math.round(timeoutMs / 60000)} minutes ` +
          `(${state ? `state ${state}` : 'not listed yet'}). It was uploaded; add it to the groups in App Store Connect once it appears.`,
      );
    }
    log(state ? `Build ${options.buildNumber} is ${state.toLowerCase()}; waiting.` : `Build ${options.buildNumber} is not listed yet; waiting.`);
    await sleep(pollMs);
  }

  await call('POST', `/v1/builds/${buildId}/relationships/betaGroups`, {
    data: groupIds.map((id) => ({ type: 'betaGroups', id })),
  });
  return { buildId: buildId!, groups: wanted };
}
