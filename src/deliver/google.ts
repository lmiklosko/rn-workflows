import { createSign } from 'node:crypto';
import { decodeBase64Strict } from '../ci/android.js';
import { UserError } from '../errors.js';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** Checks that text is a Google service account key. `secretName` only words the error. */
export function parseServiceAccount(json: string, secretName: string): ServiceAccount {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new UserError(`${secretName} is not JSON. It must be the service account key file downloaded from Google Cloud.`);
  }
  if (data?.type !== 'service_account' || !data.private_key || !data.client_email) {
    throw new UserError(
      `${secretName} is JSON but not a service account key (it needs "type": "service_account", a private_key and a client_email).`,
    );
  }
  return data as ServiceAccount;
}

/** `base64 --decode` accepts junk silently, so the decoded content is checked too. */
export const decodeServiceAccount = (base64: string, secretName: string): { account: ServiceAccount; json: string } => {
  const json = decodeBase64Strict(base64, secretName).toString('utf8');
  return { account: parseServiceAccount(json, secretName), json };
};

/** Exchanges a service account key for a short-lived access token (OAuth 2.0 JWT bearer flow). */
export async function googleAccessToken(
  account: ServiceAccount,
  scope: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned =
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
    '.' +
    base64url(JSON.stringify({ iss: account.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 600 }));

  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');
  } catch {
    throw new UserError('The service account private key could not be used to sign. The key file is damaged or truncated.');
  }

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }).toString(),
  });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new UserError(
      `Google rejected the service account ${account.client_email}: ${body.error_description ?? body.error ?? response.status}. ` +
        'The key may have been deleted or disabled.',
    );
  }
  return body.access_token as string;
}
