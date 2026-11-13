import { X509Certificate } from 'node:crypto';
import * as plist from 'plist';
import { UserError } from '../errors.js';

/** `xcodebuild -exportArchive` methods, in their Xcode 15.3+ spelling. */
export type ExportMethod = 'app-store-connect' | 'release-testing' | 'debugging' | 'enterprise';

const LEGACY_METHOD: Record<ExportMethod, string> = {
  'app-store-connect': 'app-store',
  'release-testing': 'ad-hoc',
  debugging: 'development',
  enterprise: 'enterprise',
};

export interface ProfileCertificate {
  /** Lowercase hex, no separators: the form `security find-identity` prints, lowercased. */
  sha1: string;
  commonName: string;
  expires: Date;
}

export interface ProvisioningProfile {
  uuid: string;
  name: string;
  teamId: string;
  /** `<TeamID>.<bundleId>`, possibly ending in `*`. */
  appId: string;
  /** Bundle identifier the profile is for, or null for a wildcard profile. */
  bundleId: string | null;
  expires: Date;
  exportMethod: ExportMethod;
  entitlements: Record<string, unknown>;
  certificates: ProfileCertificate[];
}

/**
 * exportArchive refuses a method that does not match the profile, and only the
 * profile knows which it is:
 *   ProvisionsAllDevices -> enterprise
 *   ProvisionedDevices   -> development or ad hoc, told apart by get-task-allow
 *   neither              -> App Store
 */
function detectExportMethod(data: Record<string, any>): ExportMethod {
  if (data.ProvisionsAllDevices === true) return 'enterprise';
  if (Array.isArray(data.ProvisionedDevices)) {
    return data.Entitlements?.['get-task-allow'] === true ? 'debugging' : 'release-testing';
  }
  return 'app-store-connect';
}

/**
 * Reads a .mobileprovision file. The file is a CMS-signed envelope around an
 * XML plist; the plist is stored in the clear, so it can be cut out without
 * verifying the signature. That keeps this usable off macOS, and Xcode does
 * the real verification when it signs.
 */
export function parseMobileProvision(file: Buffer): ProvisioningProfile {
  const text = file.toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start === -1 || end === -1) {
    throw new UserError(
      'The provisioning profile is not a .mobileprovision file: no embedded property list found. ' +
        'Check that IOS_MOBILEPROVISION_BASE64 holds the base64 of the file itself.',
    );
  }

  let data: Record<string, any>;
  try {
    data = plist.parse(Buffer.from(text.slice(start, end + '</plist>'.length), 'latin1').toString('utf8')) as Record<string, any>;
  } catch (e) {
    throw new UserError(`The provisioning profile could not be parsed: ${(e as Error).message}`);
  }

  const entitlements: Record<string, unknown> = data.Entitlements ?? {};
  const appId = String(entitlements['application-identifier'] ?? entitlements['com.apple.application-identifier'] ?? '');
  const teamId = String(data.TeamIdentifier?.[0] ?? '');
  if (!data.UUID || !data.Name || !teamId || !appId) {
    throw new UserError('The provisioning profile is missing its UUID, name, team or application identifier.');
  }

  const bundleId = appId.split('.').slice(1).join('.');

  const certificates: ProfileCertificate[] = (data.DeveloperCertificates ?? []).map((der: Buffer) => {
    const cert = new X509Certificate(der);
    return {
      sha1: cert.fingerprint.replaceAll(':', '').toLowerCase(),
      commonName: /^CN=(.+)$/m.exec(cert.subject)?.[1] ?? cert.subject,
      expires: new Date(cert.validTo),
    };
  });

  return {
    uuid: String(data.UUID),
    name: String(data.Name),
    teamId,
    appId,
    bundleId: bundleId.includes('*') ? null : bundleId,
    expires: new Date(data.ExpirationDate),
    exportMethod: detectExportMethod(data),
    entitlements,
    certificates,
  };
}

/** Xcode 15.3 renamed the export methods; older versions only know the old names. */
export function exportMethodFor(method: ExportMethod, xcodeVersion: string | null): string {
  const [major = 0, minor = 0] = (xcodeVersion ?? '').split('.').map(Number);
  const modern = !xcodeVersion || major > 15 || (major === 15 && minor >= 3);
  return modern ? method : LEGACY_METHOD[method];
}

export interface ExportOptionsInput {
  method: string;
  teamId: string;
  bundleId: string;
  profileName: string;
}

export function buildExportOptions({ method, teamId, bundleId, profileName }: ExportOptionsInput): string {
  return plist.build({
    method,
    teamID: teamId,
    signingStyle: 'manual',
    provisioningProfiles: { [bundleId]: profileName },
  });
}

/** Entitlements the app declares that the profile does not grant. */
export function missingEntitlements(app: Record<string, unknown>, profile: ProvisioningProfile): string[] {
  return Object.keys(app).filter((key) => !(key in profile.entitlements));
}
