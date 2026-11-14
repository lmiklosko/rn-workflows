import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '../errors.js';

export interface P12Info {
  /** SHA-1 of the signing certificate: lowercase hex, no separators. */
  sha1: string;
  commonName: string;
  expires: Date;
  /**
   * False when the file uses AES or a SHA-2 MAC, as OpenSSL 3 writes by default.
   * macOS `security import` rejects those as a wrong password.
   */
  appleCompatible: boolean;
  /** Whether this OpenSSL needs `-legacy` to read the file. */
  needsLegacyFlag: boolean;
}

interface OpensslResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function openssl(args: string[], password: string): OpensslResult {
  // spawnSync, not execFileSync: `pkcs12 -info` reports on stderr while succeeding.
  const result = spawnSync('openssl', args, {
    encoding: 'utf8',
    env: { ...process.env, RNW_P12_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw new UserError('openssl was not found. It is needed to read .p12 files.');
  }
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const PASS_IN = ['-passin', 'env:RNW_P12_PASSWORD'];

/** Opens a .p12 with the given password and describes its signing certificate. */
export function inspectP12(file: string, password: string): P12Info {
  // OpenSSL 3 refuses the RC2 encryption Keychain Access uses unless asked;
  // LibreSSL reads it but does not know the flag. Try both ways.
  let needsLegacyFlag = false;
  let certs = openssl(['pkcs12', '-in', file, '-nokeys', '-clcerts', ...PASS_IN], password);
  if (!certs.ok) {
    const retry = openssl(['pkcs12', '-in', file, '-nokeys', '-clcerts', '-legacy', ...PASS_IN], password);
    if (retry.ok) {
      certs = retry;
      needsLegacyFlag = true;
    }
  }
  if (!certs.ok) {
    throw new UserError(
      `${path.basename(file)} could not be opened. Either the password is wrong, or the file is not a .p12 ` +
        '(a .cer holds only the certificate and cannot sign).',
    );
  }

  const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(certs.stdout)?.[0];
  if (!pem) throw new UserError(`${path.basename(file)} contains no certificate.`);

  const legacy = needsLegacyFlag ? ['-legacy'] : [];
  const keys = openssl(['pkcs12', '-in', file, '-nocerts', '-nodes', ...legacy, ...PASS_IN], password);
  if (!keys.ok || !/PRIVATE KEY-----/.test(keys.stdout)) {
    throw new UserError(
      `${path.basename(file)} holds a certificate but no private key, so it cannot sign. ` +
        'Export it from Keychain Access by selecting the certificate together with its key.',
    );
  }

  const info = openssl(['pkcs12', '-in', file, '-info', '-noout', ...legacy, ...PASS_IN], password);
  const description = `${info.stdout}\n${info.stderr}`;
  const appleCompatible = !/PBES2|AES-?\d|MAC:\s*sha(?:2|3|5)/i.test(description);

  const cert = new X509Certificate(pem);
  return {
    sha1: cert.fingerprint.replaceAll(':', '').toLowerCase(),
    commonName: /^CN=(.+)$/m.exec(cert.subject)?.[1] ?? cert.subject,
    expires: new Date(cert.validTo),
    appleCompatible,
    needsLegacyFlag,
  };
}

/**
 * Rewrites a .p12 with 3DES and a SHA-1 MAC, the form macOS imports.
 *
 * OpenSSL cannot take both key and certificates from one pipe, so they pass
 * through two files in a private temporary directory. The key file stays
 * encrypted with the same password; the key is never on disk in the clear.
 */
export function reencodeForApple(file: string, password: string, needsLegacyFlag: boolean): Buffer {
  const legacy = needsLegacyFlag ? ['-legacy'] : [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnw-p12-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'certs.pem');
  const out = path.join(dir, 'converted.p12');
  const passOut = ['-passout', 'env:RNW_P12_PASSWORD'];

  try {
    const steps: string[][] = [
      ['pkcs12', '-in', file, '-nocerts', '-out', keyFile, ...legacy, ...PASS_IN, ...passOut],
      ['pkcs12', '-in', file, '-nokeys', '-out', certFile, ...legacy, ...PASS_IN],
      ['pkcs12', '-export', '-inkey', keyFile, '-in', certFile, '-out', out, ...PASS_IN, ...passOut,
        '-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'],
    ];
    for (const args of steps) {
      const result = openssl(args, password);
      if (!result.ok) throw new UserError(`Converting ${path.basename(file)} failed: ${result.stderr.trim()}`);
    }
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
