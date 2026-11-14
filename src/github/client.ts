import { UserError } from '../errors.js';
import { sealSecret } from './seal.js';

export interface Repo {
  owner: string;
  name: string;
}

export interface NamedItem {
  name: string;
  updatedAt: string;
}

export interface Variable extends NamedItem {
  value: string;
}

type Fetch = typeof fetch;

export class GitHubError extends UserError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The small part of the GitHub REST API the CLI needs: environments, their secrets and variables. */
export class GitHub {
  constructor(
    private readonly token: string,
    readonly repo: Repo,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = 'https://api.github.com',
  ) {}

  get slug(): string {
    return `${this.repo.owner}/${this.repo.name}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/repos/${this.slug}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rn-workflows-cli',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.ok) {
      return (response.status === 204 ? undefined : await response.json().catch(() => undefined)) as T;
    }

    const detail = await response
      .json()
      .then((j: any) => j?.message as string | undefined)
      .catch(() => undefined);
    let hint = '';
    if (response.status === 401) hint = ' The token is invalid or expired. Run `gh auth login`, or set GITHUB_TOKEN.';
    if (response.status === 403 || response.status === 404) {
      hint =
        ` Check that ${this.slug} exists and that your token can administer it: ` +
        'managing environments and secrets needs admin access and, for a classic token, the `repo` scope.';
    }
    throw new GitHubError(`GitHub ${method} ${path} failed with ${response.status}${detail ? `: ${detail}` : ''}.${hint}`, response.status);
  }

  private env(environment: string): string {
    return `/environments/${encodeURIComponent(environment)}`;
  }

  /** Creates the environment if it does not exist. Existing protection rules are left alone. */
  async ensureEnvironment(environment: string): Promise<{ created: boolean }> {
    try {
      await this.request('GET', this.env(environment));
      return { created: false };
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
    }
    await this.request('PUT', this.env(environment));
    return { created: true };
  }

  async listSecrets(environment: string): Promise<NamedItem[]> {
    const data = await this.request<{ secrets: { name: string; updated_at: string }[] }>(
      'GET',
      `${this.env(environment)}/secrets?per_page=100`,
    );
    return data.secrets.map((s) => ({ name: s.name, updatedAt: s.updated_at }));
  }

  async listVariables(environment: string): Promise<Variable[]> {
    const data = await this.request<{ variables: { name: string; value: string; updated_at: string }[] }>(
      'GET',
      `${this.env(environment)}/variables?per_page=100`,
    );
    return data.variables.map((v) => ({ name: v.name, value: v.value, updatedAt: v.updated_at }));
  }

  async setSecrets(environment: string, secrets: Record<string, string>): Promise<void> {
    const key = await this.request<{ key_id: string; key: string }>('GET', `${this.env(environment)}/secrets/public-key`);
    for (const [name, value] of Object.entries(secrets)) {
      await this.request('PUT', `${this.env(environment)}/secrets/${name}`, {
        encrypted_value: await sealSecret(key.key, value),
        key_id: key.key_id,
      });
    }
  }

  async deleteSecret(environment: string, name: string): Promise<void> {
    try {
      await this.request('DELETE', `${this.env(environment)}/secrets/${name}`);
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
    }
  }

  async setVariables(environment: string, variables: Record<string, string>): Promise<void> {
    for (const [name, value] of Object.entries(variables)) {
      try {
        await this.request('PATCH', `${this.env(environment)}/variables/${name}`, { name, value });
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 404) throw e;
        await this.request('POST', `${this.env(environment)}/variables`, { name, value });
      }
    }
  }
}
