import fs from 'node:fs';
import { inspectP12, reencodeForApple } from '../apple/p12.js';
import { parseMobileProvision } from '../apple/profile.js';
import { checkExpiry } from '../ci/ios.js';
import { UserError } from '../errors.js';
import type { GitHub } from '../github/client.js';
import { isoDate, requireFile, resolvePassword, resolveProfile, type CommonOptions } from './shared.js';

export interface IosOptions extends CommonOptions {
  p12?: string;
  p12Password?: string;
  mobileprovision?: string;
}

/**
 * Imports signing files someone handed over: a .p12, a .mobileprovision, or
 * both. A renewed profile on its own is the common case, so it is checked
 * against the fingerprint of the certificate already uploaded.
 */
export async function runIosImport(options: IosOptions, github: GitHub, cwd: string): Promise<void> {
  if (!options.p12 && !options.mobileprovision) {
    throw new UserError('Pass --p12 <file>, --mobileprovision <file>, or both.');
  }

  const profile = resolveProfile(cwd, options.profile, options.config);
  if (!profile.known) {
    console.log(`Note: profile '${profile.name}' is not in the config file; using a GitHub Environment of the same name.`);
  }
  await github.ensureEnvironment(profile.environment);
  const variables = Object.fromEntries((await github.listVariables(profile.environment)).map((v) => [v.name, v.value]));

  const secrets: Record<string, string> = {};
  const newVariables: Record<string, string> = {};
  let certSha1 = variables.IOS_CERT_SHA1 ?? '';
  let certName = variables.IOS_CERT_NAME ?? '';

  if (options.p12) {
    const file = requireFile(options.p12, 'The .p12 file');
    const password = await resolvePassword('.p12 password', options.p12Password, 'IOS_P12_PASSWORD');
    const info = inspectP12(file, password);

    let bytes: Buffer = fs.readFileSync(file);
    if (!info.appleCompatible) {
      bytes = reencodeForApple(file, password, info.needsLegacyFlag);
      console.log('The .p12 used encryption macOS cannot import; it was converted (same certificate, key and password).');
    }
    if (info.expires.getTime() < Date.now()) {
      throw new UserError(`Certificate '${info.commonName}' expired on ${isoDate(info.expires)}.`);
    }

    certSha1 = info.sha1;
    certName = info.commonName;
    secrets.IOS_P12_BASE64 = bytes.toString('base64');
    secrets.IOS_P12_PASSWORD = password;
    Object.assign(newVariables, {
      IOS_CERT_SHA1: info.sha1,
      IOS_CERT_NAME: info.commonName,
      IOS_CERT_EXPIRES: isoDate(info.expires),
    });
    console.log(`Certificate: ${info.commonName}, expires ${isoDate(info.expires)}.`);
  }

  if (options.mobileprovision) {
    const file = requireFile(options.mobileprovision, 'The .mobileprovision file');
    const bytes = fs.readFileSync(file);
    const parsed = parseMobileProvision(bytes);

    if (certSha1 && parsed.certificates.length && !parsed.certificates.some((c) => c.sha1 === certSha1)) {
      throw new UserError(
        `Provisioning profile '${parsed.name}' does not include the certificate '${certName || certSha1}'. ` +
          `It was created for: ${parsed.certificates.map((c) => c.commonName).join(', ')}. ` +
          'Nothing was uploaded. Supply the matching .p12 with --p12, or a profile generated for this certificate.',
      );
    }
    if (!certSha1) {
      console.log('Note: no certificate is on record for this environment yet, so the profile could not be checked against one.');
    }
    checkExpiry(parsed, certSha1).warnings.forEach((w) => console.log(`Warning: ${w}`));

    secrets.IOS_MOBILEPROVISION_BASE64 = bytes.toString('base64');
    Object.assign(newVariables, {
      IOS_PROFILE_NAME: parsed.name,
      IOS_PROFILE_UUID: parsed.uuid,
      IOS_PROFILE_EXPIRES: isoDate(parsed.expires),
      IOS_BUNDLE_ID: parsed.bundleId ?? '*',
      IOS_TEAM_ID: parsed.teamId,
      IOS_EXPORT_METHOD: parsed.exportMethod,
    });
    console.log(
      `Profile: '${parsed.name}' for ${parsed.bundleId ?? 'any bundle ID (wildcard)'}, team ${parsed.teamId}, ` +
        `${parsed.exportMethod}, expires ${isoDate(parsed.expires)}.`,
    );
  } else if (variables.IOS_PROFILE_NAME) {
    console.log(
      `Note: the profile on record ('${variables.IOS_PROFILE_NAME}') was not replaced. ` +
        'A profile is tied to a certificate, so a new certificate usually needs a new profile too.',
    );
  }

  await github.setSecrets(profile.environment, secrets);
  await github.setVariables(profile.environment, newVariables);
  console.log(`iOS signing is updated for environment '${profile.environment}' in ${github.slug}.`);
}
