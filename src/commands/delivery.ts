import fs from 'node:fs';
import path from 'node:path';
import { validateAscKey } from '../deliver/asc.js';
import { parseServiceAccount } from '../deliver/google.js';
import { UserError } from '../errors.js';
import type { GitHub, NamedItem, Variable } from '../github/client.js';
import { ASC_SECRETS } from '../secrets.js';
import { requireFile, resolveProfile, type CommonOptions } from './shared.js';

const SERVICE_ACCOUNT_TARGETS = {
  firebase: {
    secret: 'FIREBASE_SERVICE_ACCOUNT_BASE64',
    variable: 'FIREBASE_SERVICE_ACCOUNT_EMAIL',
    label: 'Firebase App Distribution',
    access: 'It needs the "Firebase App Distribution Admin" role in the Firebase project.',
  },
  play: {
    secret: 'GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64',
    variable: 'GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL',
    label: 'Google Play',
    access: 'Invite it in Play Console (Users and permissions) with release access to the app.',
  },
} as const;

export type ServiceAccountTarget = keyof typeof SERVICE_ACCOUNT_TARGETS;

export interface ServiceAccountOptions extends CommonOptions {
  serviceAccount?: string;
}

export async function runServiceAccountCredentials(
  target: ServiceAccountTarget,
  options: ServiceAccountOptions,
  github: GitHub,
  cwd: string,
): Promise<void> {
  const spec = SERVICE_ACCOUNT_TARGETS[target];
  const file = requireFile(options.serviceAccount, 'The service account key file (--service-account)');
  const json = fs.readFileSync(file, 'utf8');
  const account = parseServiceAccount(json, path.basename(file));

  const profile = resolveProfile(cwd, options.profile, options.config);
  await github.ensureEnvironment(profile.environment);
  await github.setSecrets(profile.environment, { [spec.secret]: Buffer.from(json, 'utf8').toString('base64') });
  await github.setVariables(profile.environment, { [spec.variable]: account.client_email });

  console.log(`${spec.label} delivery is set for environment '${profile.environment}' in ${github.slug}.`);
  console.log(`Service account: ${account.client_email}. ${spec.access}`);
}

export interface AscOptions extends CommonOptions {
  key?: string;
  keyId?: string;
  issuerId?: string;
}

export async function runAscCredentials(options: AscOptions, github: GitHub, cwd: string): Promise<void> {
  const file = requireFile(options.key, 'The App Store Connect API key file (--key AuthKey_XXXX.p8)');
  // Apple names the download AuthKey_<key id>.p8, so the ID rarely needs typing.
  const keyId = options.keyId ?? /^AuthKey_([A-Z0-9]+)\.p8$/.exec(path.basename(file))?.[1];
  if (!keyId) throw new UserError('Pass --key-id: it could not be read from the file name (expected AuthKey_<ID>.p8).');
  const issuerId = options.issuerId ?? process.env.APP_STORE_CONNECT_API_ISSUER_ID;
  if (!issuerId) throw new UserError('Pass --issuer-id: the issuer UUID from App Store Connect > Users and Access > Integrations.');

  const key = validateAscKey({ keyId, issuerId, privateKey: fs.readFileSync(file, 'utf8') });

  const profile = resolveProfile(cwd, options.profile, options.config);
  await github.ensureEnvironment(profile.environment);
  await github.setSecrets(profile.environment, {
    APP_STORE_CONNECT_API_KEY_ID: key.keyId,
    APP_STORE_CONNECT_API_ISSUER_ID: key.issuerId,
    APP_STORE_CONNECT_API_KEY_BASE64: Buffer.from(key.privateKey, 'utf8').toString('base64'),
  });
  await github.setVariables(profile.environment, { APP_STORE_CONNECT_KEY_ID: key.keyId });

  console.log(`TestFlight delivery is set for environment '${profile.environment}' in ${github.slug} (API key ${key.keyId}).`);
  console.log('The key needs the App Manager role or higher to upload builds and manage TestFlight groups.');
}

/** One line for `status`: which delivery targets have their credentials. */
export function deliveryStatus(secrets: NamedItem[], variables: Variable[]): { line: string; problems: string[] } {
  const names = new Set(secrets.map((s) => s.name));
  const vars = Object.fromEntries(variables.map((v) => [v.name, v.value]));
  const ready: string[] = [];
  const problems: string[] = [];

  for (const [target, spec] of Object.entries(SERVICE_ACCOUNT_TARGETS)) {
    if (names.has(spec.secret)) ready.push(vars[spec.variable] ? `${target} (${vars[spec.variable]})` : target);
  }
  const asc = ASC_SECRETS.filter((n) => names.has(n));
  if (asc.length === ASC_SECRETS.length) {
    ready.push(vars.APP_STORE_CONNECT_KEY_ID ? `testflight (key ${vars.APP_STORE_CONNECT_KEY_ID})` : 'testflight');
  } else if (asc.length > 0) {
    problems.push(`testflight is missing ${ASC_SECRETS.filter((n) => !names.has(n)).join(', ')}`);
  }

  const parts = [ready.length ? ready.join(', ') : 'no targets set up', ...problems.map((p) => `INCOMPLETE: ${p}`)];
  return { line: parts.join('; '), problems };
}
