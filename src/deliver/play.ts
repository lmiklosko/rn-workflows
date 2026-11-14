import fs from 'node:fs';
import { UserError } from '../errors.js';
import { googleAccessToken, type ServiceAccount } from './google.js';

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com';

export interface PlayUpload {
  account: ServiceAccount;
  packageName: string;
  aabPath: string;
  track: string;
  /** `completed` rolls the release out on the track; `draft` leaves it for someone to release in the console. */
  status: 'completed' | 'draft';
  fetchImpl?: typeof fetch;
}

export interface PlayResult {
  versionCode: number;
}

function explain(message: string, upload: PlayUpload): string {
  if (/draft app/i.test(message)) {
    return ' The app has never been published, so Google only accepts draft releases: set "status": "draft" under deliver.play.';
  }
  if (/caller does not have permission|insufficient permissions/i.test(message)) {
    return ` Invite ${upload.account.client_email} in Play Console (Users and permissions) with release access to this app.`;
  }
  if (/package not found|No application was found/i.test(message)) {
    return ` Play has no app with package ${upload.packageName} that this account can see. The first build of a new app must be uploaded by hand in Play Console.`;
  }
  if (/version code .* has already been used/i.test(message)) {
    return ' Build numbers come from the workflow run number: re-running a run that already uploaded reuses its number. Start a new run instead.';
  }
  return '';
}

/**
 * Uploads a bundle to a Play track. Play's API is transactional: everything
 * happens inside an "edit" that only takes effect when committed, so a failure
 * part-way leaves the app untouched.
 */
export async function uploadToPlay(upload: PlayUpload): Promise<PlayResult> {
  const fetchImpl = upload.fetchImpl ?? fetch;
  const token = await googleAccessToken(upload.account, SCOPE, fetchImpl);
  const app = `applications/${encodeURIComponent(upload.packageName)}`;

  const call = async <T>(what: string, url: string, init: RequestInit): Promise<T> => {
    const response = await fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = String(body?.error?.message ?? response.status);
      throw new UserError(`Google Play: ${what} failed: ${message}.${explain(message, upload)}`);
    }
    return body as T;
  };
  const json = (body: unknown): RequestInit => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const edit = await call<{ id: string }>('opening an edit', `${API}/androidpublisher/v3/${app}/edits`, { method: 'POST', ...json({}) });

  const bundle = await call<{ versionCode: number }>(
    'uploading the bundle',
    `${API}/upload/androidpublisher/v3/${app}/edits/${edit.id}/bundles?uploadType=media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await fs.openAsBlob(upload.aabPath),
    },
  );

  await call('assigning the track', `${API}/androidpublisher/v3/${app}/edits/${edit.id}/tracks/${encodeURIComponent(upload.track)}`, {
    method: 'PUT',
    ...json({ track: upload.track, releases: [{ status: upload.status, versionCodes: [String(bundle.versionCode)] }] }),
  });

  await call('committing', `${API}/androidpublisher/v3/${app}/edits/${edit.id}:commit`, { method: 'POST' });
  return { versionCode: bundle.versionCode };
}
