import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMobileProvision, type ProvisioningProfile } from '../apple/profile.js';
import { UserError } from '../errors.js';
import { decodeBase64Strict } from './android.js';

export interface IosSigningInput {
  p12Base64?: string;
  p12Password?: string;
  profileBase64?: string;
}

/** What `ci ios-credentials` leaves behind for later steps and for cleanup. */
export interface IosState {
  keychain: string;
  /** The user's keychain search list before ours was added, to restore on cleanup. */
  previousKeychains: string[];
  profilePath: string;
  installedProfiles: string[];
  identity: string;
  identitySha1: string;
}

const STATE_FILE = 'state.json';

export const readIosState = (dir: string): IosState | null => {
  const file = path.join(dir, STATE_FILE);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as IosState) : null;
};

function security(args: string[], options: { quiet?: boolean } = {}): string {
  try {
    return execFileSync('security', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'pipe'],
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new UserError('The `security` tool was not found. iOS signing needs a macOS runner.');
    }
    throw new Error((err.stderr ?? '').trim() || err.message);
  }
}

/** Parses `security list-keychains`, which prints one quoted path per line. */
export function parseKeychainList(output: string): string[] {
  return [...output.matchAll(/^\s*"(.+)"\s*$/gm)].map((m) => m[1]!);
}

/** Parses the first identity from `security find-identity`. */
export function parseIdentity(output: string): { sha1: string; name: string } | null {
  const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+?)"/m.exec(output);
  return match ? { sha1: match[1]!.toLowerCase(), name: match[2]! } : null;
}

/** Xcode 16 moved the profile directory; older versions and some tools still read the old one. */
export function profileDirectories(home: string = os.homedir()): string[] {
  return [
    path.join(home, 'Library', 'MobileDevice', 'Provisioning Profiles'),
    path.join(home, 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
  ];
}

const DAY = 24 * 60 * 60 * 1000;

export interface ExpiryCheck {
  /** Things that will expire within 30 days. */
  warnings: string[];
}

export function checkExpiry(profile: ProvisioningProfile, identitySha1: string, now: Date = new Date()): ExpiryCheck {
  const warnings: string[] = [];
  const check = (what: string, expires: Date): void => {
    const days = Math.floor((expires.getTime() - now.getTime()) / DAY);
    if (days < 0) {
      throw new UserError(`${what} expired on ${expires.toISOString().slice(0, 10)}. Renew it and update the secret.`);
    }
    if (days <= 30) warnings.push(`${what} expires in ${days} day${days === 1 ? '' : 's'}, on ${expires.toISOString().slice(0, 10)}.`);
  };

  check(`Provisioning profile '${profile.name}'`, profile.expires);
  const cert = profile.certificates.find((c) => c.sha1 === identitySha1);
  if (cert) check(`Signing certificate '${cert.commonName}'`, cert.expires);
  return { warnings };
}

export interface InstalledIosCredentials {
  profile: ProvisioningProfile;
  state: IosState;
  warnings: string[];
}

/**
 * Puts the certificate in a throwaway keychain and the profile where Xcode
 * looks for it. Everything is recorded in a state file so that cleanup can
 * undo exactly this and nothing else, which matters on self-hosted runners.
 */
export function installIosCredentials(input: IosSigningInput, dir: string): InstalledIosCredentials {
  const missing = [
    !input.p12Base64?.trim() && 'IOS_P12_BASE64',
    // An empty password is not valid for `security import`, so it counts as missing.
    !input.p12Password && 'IOS_P12_PASSWORD',
    !input.profileBase64?.trim() && 'IOS_MOBILEPROVISION_BASE64',
  ].filter(Boolean) as string[];
  if (missing.length) {
    throw new UserError(
      `iOS signing needs ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} empty. ` +
        "Check the secrets exist in this build's GitHub Environment and that the calling workflow passes them by name.",
    );
  }

  const p12 = decodeBase64Strict(input.p12Base64!, 'IOS_P12_BASE64');
  const profileBytes = decodeBase64Strict(input.profileBase64!, 'IOS_MOBILEPROVISION_BASE64');
  const profile = parseMobileProvision(profileBytes);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p12Path = path.join(dir, 'certificate.p12');
  const profilePath = path.join(dir, 'profile.mobileprovision');
  fs.writeFileSync(p12Path, p12, { mode: 0o600 });
  fs.writeFileSync(profilePath, profileBytes, { mode: 0o600 });

  const keychain = path.join(dir, 'signing.keychain-db');
  const keychainPassword = randomBytes(24).toString('hex');
  const previousKeychains = parseKeychainList(security(['list-keychains', '-d', 'user']));

  // The state file is written before anything is changed, so cleanup works
  // even if a later command in this function fails.
  const state: IosState = { keychain, previousKeychains, profilePath, installedProfiles: [], identity: '', identitySha1: '' };
  const saveState = (): void => fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
  saveState();

  security(['create-keychain', '-p', keychainPassword, keychain]);
  // No auto-lock for six hours: a locked keychain makes codesign hang on a prompt.
  security(['set-keychain-settings', '-lut', '21600', keychain]);
  security(['unlock-keychain', '-p', keychainPassword, keychain]);

  try {
    security(['import', p12Path, '-k', keychain, '-f', 'pkcs12', '-P', input.p12Password!, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
  } catch (e) {
    if (e instanceof UserError) throw e;
    // `security import` reports every failure the same way, so list the causes.
    throw new UserError(
      `The signing certificate could not be imported (${(e as Error).message}). Likely causes:\n` +
        '- IOS_P12_PASSWORD is wrong; a trailing newline from copy-paste is the usual reason.\n' +
        '- The .p12 was written by OpenSSL 3 with AES encryption, which macOS rejects whatever the password. ' +
        'Re-export it from Keychain Access, or with: openssl pkcs12 -export -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1\n' +
        '- IOS_P12_BASE64 holds a .cer or a truncated file instead of the full .p12.',
    );
  } finally {
    fs.rmSync(p12Path, { force: true });
  }

  // Let Apple's tools use the key without a confirmation dialog.
  security(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain], { quiet: true });
  security(['list-keychains', '-d', 'user', '-s', keychain, ...previousKeychains]);

  const identity = parseIdentity(security(['find-identity', '-p', 'codesigning', keychain]));
  if (!identity) {
    throw new UserError(
      'The .p12 was imported but contains no code signing identity. ' +
        'It must hold both the certificate and its private key; a certificate exported alone will not sign.',
    );
  }
  state.identity = identity.name;
  state.identitySha1 = identity.sha1;

  if (profile.certificates.length && !profile.certificates.some((c) => c.sha1 === identity.sha1)) {
    throw new UserError(
      `Provisioning profile '${profile.name}' does not include the certificate '${identity.name}'. ` +
        `It was created for: ${profile.certificates.map((c) => c.commonName).join(', ')}. ` +
        'Regenerate the profile with this certificate selected, or supply the matching .p12.',
    );
  }

  const { warnings } = checkExpiry(profile, identity.sha1);

  for (const directory of profileDirectories()) {
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `${profile.uuid}.mobileprovision`);
    // A profile that is already there belongs to the machine, not to this run.
    if (fs.existsSync(target)) continue;
    fs.copyFileSync(profilePath, target);
    state.installedProfiles.push(target);
  }
  saveState();

  return { profile, state, warnings };
}

export function removeIosCredentials(dir: string): void {
  const state = readIosState(dir);
  if (!state) return;

  for (const file of state.installedProfiles) fs.rmSync(file, { force: true });

  try {
    const current = parseKeychainList(security(['list-keychains', '-d', 'user']));
    if (current.includes(state.keychain)) {
      security(['list-keychains', '-d', 'user', '-s', ...current.filter((k) => k !== state.keychain)]);
    }
  } catch {
    // best effort: the keychain is deleted below either way
  }
  try {
    security(['delete-keychain', state.keychain], { quiet: true });
  } catch {
    fs.rmSync(state.keychain, { force: true });
  }
}

export function xcodeVersion(): string | null {
  try {
    return /Xcode (\d+(?:\.\d+)*)/.exec(execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }))?.[1] ?? null;
  } catch {
    return null;
  }
}
