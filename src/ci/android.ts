import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '../errors.js';

// ---------------------------------------------------------------------------
// versionCode
// ---------------------------------------------------------------------------

/** Replaces the versionCode in a Groovy or Kotlin app build script. */
export function patchVersionCode(contents: string, versionCode: number): string {
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    // The upper bound is Google Play's.
    throw new UserError(`versionCode must be an integer between 1 and 2100000000, got ${versionCode}.`);
  }
  const pattern = /(\bversionCode\b\s*=?\s*)\d+/;
  if (!pattern.test(contents)) {
    throw new UserError(
      'Could not find a numeric versionCode in the app build script. ' +
        'rn-workflows sets the build number there after `expo prebuild`.',
    );
  }
  return contents.replace(pattern, `$1${versionCode}`);
}

export function findAppBuildScript(appDir: string): string {
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    const file = path.join(appDir, 'android', 'app', name);
    if (fs.existsSync(file)) return file;
  }
  throw new UserError(
    `No android/app/build.gradle under ${appDir}. Has \`expo prebuild --platform android\` run?`,
  );
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface AndroidSigningInput {
  keystoreBase64?: string;
  keystorePassword?: string;
  keyAlias?: string;
  keyPassword?: string;
}

const SECRET_NAMES = {
  keystoreBase64: 'ANDROID_KEYSTORE_BASE64',
  keystorePassword: 'ANDROID_KEYSTORE_PASSWORD',
  keyAlias: 'ANDROID_KEY_ALIAS',
} as const;

/**
 * `Buffer.from(x, 'base64')` drops characters it does not understand, so a
 * mangled secret would decode to a short, wrong file. Check the alphabet first.
 */
export function decodeBase64Strict(value: string, secretName: string): Buffer {
  const compact = value.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new UserError(
      `${secretName} is not valid base64. Encode the file with: base64 -i <file> | tr -d '\\n'`,
    );
  }
  return Buffer.from(compact, 'base64');
}

function keytool(args: string[], passwords: Record<string, string>): string {
  try {
    return execFileSync('keytool', ['-J-Duser.language=en', ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...passwords },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === 'ENOENT') {
      throw new UserError('keytool was not found. A JDK must be set up before Android signing credentials are installed.');
    }
    // keytool reports its errors on stdout.
    throw new Error(`${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message);
  }
}

export interface KeystoreInfo {
  certSha256: string;
}

/** Opens the keystore with the given credentials and returns the signing certificate's fingerprint. */
export function inspectKeystore(file: string, storePassword: string, alias: string, keyPassword: string): KeystoreInfo {
  const store = ['-keystore', file, '-storepass:env', 'RNW_STOREPASS'];
  const env = { RNW_STOREPASS: storePassword, RNW_KEYPASS: keyPassword };

  let listing: string;
  try {
    listing = keytool(['-list', '-v', ...store, '-alias', alias], env);
  } catch (e) {
    const message = (e as Error).message;
    if (e instanceof UserError) throw e;
    if (/password was incorrect|keystore password/i.test(message)) {
      throw new UserError(
        'The Android keystore did not open with ANDROID_KEYSTORE_PASSWORD. ' +
          'A trailing newline from copy-paste is the usual cause.',
      );
    }
    if (/does not exist/i.test(message)) {
      let aliases = '';
      try {
        aliases = [...keytool(['-list', ...store], env).matchAll(/^(.+?), .+?, (?:PrivateKeyEntry|trustedCertEntry)/gm)]
          .map((m) => m[1])
          .join(', ');
      } catch {
        // best effort
      }
      throw new UserError(
        `The Android keystore has no key with alias '${alias}' (ANDROID_KEY_ALIAS).` +
          (aliases ? ` It contains: ${aliases}.` : ''),
      );
    }
    throw new UserError(`The Android keystore could not be read: ${message}`);
  }

  const sha = /SHA-?256:\s*([0-9A-Fa-f:]+)/.exec(listing)?.[1];
  if (!sha) throw new UserError('Could not read the certificate fingerprint from the Android keystore.');

  // -list never touches the private key. Generating a certificate request does,
  // so a wrong key password fails here in a second instead of at the end of the build.
  try {
    keytool(['-certreq', ...store, '-alias', alias, '-keypass:env', 'RNW_KEYPASS'], env);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(
      `The key '${alias}' in the Android keystore could not be unlocked with ANDROID_KEY_PASSWORD ` +
        '(or with ANDROID_KEYSTORE_PASSWORD, when the key password is not set).',
    );
  }

  return { certSha256: sha.replaceAll(':', '').toLowerCase() };
}

/** Escapes a value for a Java .properties file, which is how Gradle reads gradle.properties. */
export function escapeProperty(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/^ /, '\\ ')
    .replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const BLOCK_START = '# >>> rn-workflows signing (temporary, removed by `rn-workflows ci cleanup`)';
const BLOCK_END = '# <<< rn-workflows signing';

export function gradlePropertiesFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'), 'gradle.properties');
}

export function stripSigningBlock(contents: string): string {
  const start = contents.indexOf(BLOCK_START);
  if (start === -1) return contents;
  const end = contents.indexOf(BLOCK_END, start);
  const after = end === -1 ? contents.length : end + BLOCK_END.length;
  return (contents.slice(0, start) + contents.slice(after).replace(/^\r?\n/, '')).replace(/\n{3,}$/, '\n');
}

export function withSigningBlock(contents: string, properties: Record<string, string>): string {
  const base = stripSigningBlock(contents);
  const lines = Object.entries(properties).map(([key, value]) => `${key}=${escapeProperty(value)}`);
  const separator = base && !base.endsWith('\n') ? '\n' : '';
  return `${base}${separator}${BLOCK_START}\n${lines.join('\n')}\n${BLOCK_END}\n`;
}

export interface InstalledAndroidCredentials {
  keystorePath: string;
  certSha256: string;
}

/**
 * Decodes and checks the keystore, then hands it to Gradle through the
 * Android Gradle Plugin's injected signing properties. Those override the
 * signing config of every build type, so the generated build script needs no
 * edit. They go in the user-level gradle.properties, not on the command line,
 * to keep the passwords out of the process list.
 */
export function installAndroidCredentials(
  input: AndroidSigningInput,
  dir: string,
  propertiesFile: string,
): InstalledAndroidCredentials {
  const missing = (Object.keys(SECRET_NAMES) as (keyof typeof SECRET_NAMES)[])
    .filter((key) => !input[key]?.trim())
    .map((key) => SECRET_NAMES[key]);
  if (missing.length) {
    throw new UserError(
      `Android signing needs ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} empty. ` +
        "Check the secrets exist in this build's GitHub Environment and that the calling workflow passes them by name.",
    );
  }

  const storePassword = input.keystorePassword!;
  const alias = input.keyAlias!.trim();
  const keyPassword = input.keyPassword || storePassword;

  const keystore = decodeBase64Strict(input.keystoreBase64!, SECRET_NAMES.keystoreBase64);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keystorePath = path.join(dir, 'release.keystore');
  fs.writeFileSync(keystorePath, keystore, { mode: 0o600 });

  const { certSha256 } = inspectKeystore(keystorePath, storePassword, alias, keyPassword);

  const existing = fs.existsSync(propertiesFile) ? fs.readFileSync(propertiesFile, 'utf8') : '';
  fs.mkdirSync(path.dirname(propertiesFile), { recursive: true });
  fs.writeFileSync(
    propertiesFile,
    withSigningBlock(existing, {
      'android.injected.signing.store.file': keystorePath,
      'android.injected.signing.store.password': storePassword,
      'android.injected.signing.key.alias': alias,
      'android.injected.signing.key.password': keyPassword,
    }),
    { mode: 0o600 },
  );

  return { keystorePath, certSha256 };
}

export function removeAndroidCredentials(propertiesFile: string): void {
  if (!fs.existsSync(propertiesFile)) return;
  const contents = fs.readFileSync(propertiesFile, 'utf8');
  const stripped = stripSigningBlock(contents);
  if (stripped === contents) return;
  if (stripped.trim()) {
    fs.writeFileSync(propertiesFile, stripped);
  } else {
    fs.rmSync(propertiesFile);
  }
}
