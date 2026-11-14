import { createRequire } from 'node:module';
import { GitHub } from '../src/github/client.js';

const sodium = createRequire(import.meta.url)('libsodium-wrappers') as typeof import('libsodium-wrappers');

interface Environment {
  secrets: Map<string, string>;
  variables: Map<string, string>;
}

/**
 * An in-memory stand-in for the GitHub API routes the CLI uses. It holds a real
 * key pair and decrypts uploaded secrets, so a test that reads a secret back
 * proves the client sealed it the way GitHub requires.
 */
export async function fakeGitHub(repo = { owner: 'acme', name: 'app' }) {
  await sodium.ready;
  const keys = sodium.crypto_box_keypair();
  const environments = new Map<string, Environment>();
  const calls: string[] = [];

  const json = (status: number, body?: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const { pathname } = new URL(String(url));
    calls.push(`${method} ${pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    const match = /^\/repos\/acme\/app\/environments\/([^/]+)(?:\/(secrets|variables)(?:\/([^/]+))?)?$/.exec(pathname);
    if (!match) return json(404, { message: 'Not Found' });
    const name = decodeURIComponent(match[1]!);
    const [, , kind, item] = match;
    const env = environments.get(name);

    if (!kind) {
      if (method === 'GET') return env ? json(200, { name }) : json(404, { message: 'Not Found' });
      if (method === 'PUT') {
        if (!env) environments.set(name, { secrets: new Map(), variables: new Map() });
        return json(200, { name });
      }
    }
    if (!env) return json(404, { message: 'Not Found' });

    if (kind === 'secrets') {
      if (method === 'GET' && item === 'public-key') {
        return json(200, { key_id: 'key-1', key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL) });
      }
      if (method === 'GET' && !item) {
        return json(200, { secrets: [...env.secrets.keys()].map((n) => ({ name: n, updated_at: '2026-11-14T10:00:00Z' })) });
      }
      if (method === 'PUT' && item) {
        if (body.key_id !== 'key-1') return json(422, { message: 'wrong key' });
        const opened = sodium.crypto_box_seal_open(
          sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL),
          keys.publicKey,
          keys.privateKey,
        );
        env.secrets.set(item, sodium.to_string(opened));
        return json(201);
      }
      if (method === 'DELETE' && item) {
        return env.secrets.delete(item) ? json(204) : json(404, { message: 'Not Found' });
      }
    }

    if (kind === 'variables') {
      if (method === 'GET' && !item) {
        return json(200, {
          variables: [...env.variables].map(([n, value]) => ({ name: n, value, updated_at: '2026-11-14T10:00:00Z' })),
        });
      }
      if (method === 'POST' && !item) {
        env.variables.set(body.name, body.value);
        return json(201);
      }
      if (method === 'PATCH' && item) {
        if (!env.variables.has(item)) return json(404, { message: 'Not Found' });
        env.variables.set(item, body.value);
        return json(204);
      }
    }
    return json(404, { message: 'Not Found' });
  }) as typeof fetch;

  return {
    github: new GitHub('test-token', repo, fetchImpl),
    environments,
    calls,
    secrets: (name: string) => Object.fromEntries(environments.get(name)?.secrets ?? []),
    variables: (name: string) => Object.fromEntries(environments.get(name)?.variables ?? []),
  };
}
