import { execFileSync } from 'node:child_process';
import { UserError } from '../errors.js';
import { GitHub, type Repo } from './client.js';

/** Accepts `owner/name` and the https, ssh and scp-style forms of a github.com remote. */
export function parseRepo(value: string): Repo | null {
  const trimmed = value.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const match =
    /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed) ??
    /github\.com[:/]([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

function run(command: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function detectRepo(cwd: string, explicit?: string): Repo {
  if (explicit) {
    const repo = parseRepo(explicit);
    if (!repo) throw new UserError(`--repo must look like owner/name, got '${explicit}'.`);
    return repo;
  }
  const remote = run('git', ['remote', 'get-url', 'origin'], cwd);
  const repo = remote ? parseRepo(remote) : null;
  if (!repo) {
    throw new UserError(
      'Could not tell which GitHub repository this is: no github.com `origin` remote found. Pass --repo owner/name.',
    );
  }
  return repo;
}

/** An explicit token wins; otherwise borrow the GitHub CLI's login. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || run('gh', ['auth', 'token'], cwd);
  if (!token) {
    throw new UserError('No GitHub credentials found. Run `gh auth login`, or set GITHUB_TOKEN to a token that can administer the repository.');
  }
  return token;
}

export const connect = (cwd: string, explicitRepo?: string): GitHub =>
  new GitHub(resolveToken(process.env, cwd), detectRepo(cwd, explicitRepo));
