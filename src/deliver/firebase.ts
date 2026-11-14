import fs from 'node:fs';
import path from 'node:path';
import * as plist from 'plist';

/** Pinned like the rest of the toolchain; bump deliberately. */
export const FIREBASE_TOOLS = 'firebase-tools@15';

/**
 * Finds the Firebase app ID in the committed google-services.json, preferring
 * the client registered for this package when the file lists several.
 */
export function androidFirebaseAppId(appDir: string, packageName: string | null): string | null {
  for (const file of [path.join(appDir, 'google-services.json'), path.join(appDir, 'android', 'app', 'google-services.json')]) {
    try {
      const clients: any[] = JSON.parse(fs.readFileSync(file, 'utf8')).client ?? [];
      const match =
        clients.find((c) => c?.client_info?.android_client_info?.package_name === packageName) ??
        (clients.length === 1 ? clients[0] : undefined);
      const id = match?.client_info?.mobilesdk_app_id;
      if (id) return String(id);
    } catch {
      // try the next location
    }
  }
  return null;
}

export function iosFirebaseAppId(appDir: string): string | null {
  const candidates = [path.join(appDir, 'GoogleService-Info.plist')];
  const iosDir = path.join(appDir, 'ios');
  if (fs.existsSync(iosDir)) {
    for (const entry of fs.readdirSync(iosDir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(iosDir, entry.name, 'GoogleService-Info.plist'));
    }
  }
  for (const file of candidates) {
    try {
      const id = (plist.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).GOOGLE_APP_ID;
      if (id) return String(id);
    } catch {
      // try the next location
    }
  }
  return null;
}

export interface FirebaseDistribution {
  file: string;
  appId: string;
  groups: string[];
  releaseNotes: string;
}

export const firebaseArgs = ({ file, appId, groups, releaseNotes }: FirebaseDistribution): string[] => [
  '--yes',
  FIREBASE_TOOLS,
  'appdistribution:distribute',
  file,
  '--app',
  appId,
  '--release-notes',
  releaseNotes,
  ...(groups.length ? ['--groups', groups.join(',')] : []),
];
