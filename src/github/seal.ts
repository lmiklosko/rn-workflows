import { createRequire } from 'node:module';

// Loaded through require: the package's ESM entry point has been broken in
// several releases, while the CommonJS one is stable.
const sodium = createRequire(import.meta.url)('libsodium-wrappers') as typeof import('libsodium-wrappers');

/**
 * Encrypts a secret for the GitHub API, which only accepts values sealed with
 * the repository's or environment's public key (a libsodium sealed box).
 */
export async function sealSecret(publicKeyBase64: string, value: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
