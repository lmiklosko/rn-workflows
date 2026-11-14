import fs from 'node:fs';
import path from 'node:path';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { DEFAULT_CONFIG_FILE, loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { UserError } from '../errors.js';
import type { GitHub } from '../github/client.js';
import { SCHEMA_URL, WORKFLOW_REF, WORKFLOW_SECRETS } from '../secrets.js';
import { runAndroidCredentials } from './android.js';
import { runIosImport } from './ios.js';
import { CREDENTIALS_DIR, ensureGitignored } from './shared.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'android', 'ios', 'dist', 'build', '.expo']);

const isExpoApp = (dir: string): boolean => {
  if (['app.config.js', 'app.config.ts', 'app.config.mjs', 'app.config.cjs'].some((f) => fs.existsSync(path.join(dir, f)))) {
    return true;
  }
  try {
    return 'expo' in JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
  } catch {
    return false;
  }
};

/** Expo apps at the repo root or up to two directories down, as paths relative to the root. */
export function findExpoApps(root: string, depth = 2): string[] {
  const found: string[] = [];
  const visit = (dir: string, remaining: number): void => {
    if (isExpoApp(dir)) {
      found.push(path.relative(root, dir) || '.');
      return;
    }
    if (remaining === 0) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        visit(path.join(dir, entry.name), remaining - 1);
      }
    }
  };
  visit(root, depth);
  return found.sort();
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;

export function parseProfileNames(value: string): string[] {
  const names = [...new Set(value.split(',').map((n) => n.trim()).filter(Boolean))];
  if (!names.length) throw new UserError('At least one profile name is required.');
  for (const name of names) {
    if (!PROFILE_NAME.test(name)) {
      throw new UserError(`'${name}' is not a usable profile name. Use letters, digits, spaces, dots, dashes and underscores.`);
    }
  }
  return names;
}

export function buildConfig(appDir: string, profiles: string[], existing: Config = {}): Config {
  return {
    $schema: SCHEMA_URL,
    ...existing,
    ...(appDir !== '.' ? { workingDirectory: appDir } : {}),
    profiles: { ...Object.fromEntries(profiles.map((name) => [name, {}])), ...existing.profiles },
  };
}

/** The workflow an app repo keeps: it owns the triggers and hands everything else to the shared workflow. */
export function callerWorkflow(profiles: string[]): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  return [
    'name: Mobile build',
    '',
    '# Scaffolded by `rn-workflows init`. Triggers are yours to change: add `push`,',
    '# tags or a schedule, and pass the profile to build for each.',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      profile:',
    '        description: Build profile (also the GitHub Environment holding its secrets)',
    '        type: choice',
    `        default: ${quote(profiles[0]!)}`,
    '        options:',
    ...profiles.map((p) => `          - ${quote(p)}`),
    '      platform:',
    '        description: Platform to build',
    '        type: choice',
    '        default: all',
    '        options:',
    '          - all',
    '          - android',
    '          - ios',
    '',
    'concurrency:',
    '  group: mobile-build-${{ github.ref }}-${{ inputs.profile }}',
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  build:',
    `    uses: ${WORKFLOW_REF}`,
    '    with:',
    '      profile: ${{ inputs.profile }}',
    '      platform: ${{ inputs.platform }}',
    '    # Passed one by one on purpose: `secrets: inherit` is ignored when the shared',
    '    # workflow lives under a different owner. Values come from the Environment',
    '    # named after the profile; ones you have not set are simply empty.',
    '    secrets:',
    ...WORKFLOW_SECRETS.map((name) => `      ${name}: \${{ secrets.${name} }}`),
    '',
  ].join('\n');
}

export interface InitOptions {
  repo?: string;
  appDir?: string;
  profiles?: string;
  yes?: boolean;
  skipCredentials?: boolean;
}

export async function runInit(options: InitOptions, github: GitHub, cwd: string): Promise<void> {
  const interactive = !options.yes && process.stdin.isTTY === true;
  console.log(`Setting up rn-workflows for ${github.slug}\n`);

  // 1. Where the app is.
  let appDir = options.appDir;
  if (!appDir) {
    const apps = findExpoApps(cwd);
    if (apps.length === 1) {
      appDir = apps[0]!;
    } else if (apps.length > 1 && interactive) {
      appDir = await select({ message: 'Which Expo app should be built?', choices: apps.map((a) => ({ value: a })) });
    } else if (apps.length > 1) {
      throw new UserError(`Several Expo apps found (${apps.join(', ')}). Pass --app-dir to pick one.`);
    } else {
      throw new UserError('No Expo app found here (no app.json with an "expo" key, and no app.config.*). Pass --app-dir.');
    }
  } else if (!isExpoApp(path.resolve(cwd, appDir))) {
    throw new UserError(`${appDir} does not look like an Expo app (no app.json with an "expo" key, and no app.config.*).`);
  }
  console.log(`Expo app: ${appDir === '.' ? 'repository root' : appDir}`);

  // 2. Profiles.
  const existing = loadConfig(cwd);
  const existingProfiles = Object.keys(existing.config.profiles ?? {});
  let profiles: string[];
  if (options.profiles) {
    profiles = parseProfileNames(options.profiles);
  } else if (existingProfiles.length) {
    profiles = existingProfiles;
  } else if (interactive) {
    profiles = parseProfileNames(
      await input({
        message: 'Build profiles, comma-separated (each becomes a GitHub Environment):',
        default: 'staging, production',
      }),
    );
  } else {
    profiles = ['production'];
  }

  // 3. Files.
  const config = buildConfig(appDir, profiles, existing.config);
  fs.writeFileSync(path.join(cwd, DEFAULT_CONFIG_FILE), JSON.stringify(config, null, 2) + '\n');
  console.log(`${existing.file ? 'Updated' : 'Wrote'} ${DEFAULT_CONFIG_FILE}`);

  const allProfiles = Object.keys(config.profiles ?? {});
  const workflowFile = path.join('.github', 'workflows', 'mobile-build.yml');
  if (fs.existsSync(path.join(cwd, workflowFile))) {
    console.log(`Kept existing ${workflowFile}`);
  } else {
    fs.mkdirSync(path.join(cwd, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(cwd, workflowFile), callerWorkflow(allProfiles));
    console.log(`Wrote ${workflowFile}`);
  }

  if (ensureGitignored(cwd, `${CREDENTIALS_DIR}/`)) console.log(`Added ${CREDENTIALS_DIR}/ to .gitignore`);

  // 4. Environments.
  for (const name of allProfiles) {
    const environment = config.profiles?.[name]?.environment ?? name;
    const { created } = await github.ensureEnvironment(environment);
    console.log(`${created ? 'Created' : 'Found'} GitHub Environment '${environment}'`);
  }

  // 5. Credentials.
  if (options.skipCredentials || !interactive) {
    console.log('\nNext, add signing credentials per profile:');
    console.log('  rn-workflows credentials android --profile <name> --generate');
    console.log('  rn-workflows credentials ios --profile <name> --p12 <file> --mobileprovision <file>');
    console.log('and, for the stores you deliver to: credentials firebase, credentials play, credentials testflight.');
    return;
  }

  for (const name of allProfiles) {
    console.log(`\nProfile ${name}`);
    const android = await select({
      message: 'Android signing:',
      choices: [
        { value: 'skip', name: 'Skip for now' },
        { value: 'generate', name: 'Generate a new upload keystore' },
        { value: 'import', name: 'Import an existing keystore' },
      ],
    });
    if (android === 'generate') {
      await runAndroidCredentials({ profile: name, generate: true }, github, cwd);
    } else if (android === 'import') {
      const keystore = await input({ message: 'Path to the keystore file:' });
      const alias = await input({ message: 'Key alias:' });
      await runAndroidCredentials({ profile: name, keystore, alias }, github, cwd);
    }

    const ios = await checkbox({
      message: 'iOS signing: which files do you have? (none to skip)',
      choices: [
        { value: 'p12', name: 'Certificate with private key (.p12)' },
        { value: 'profile', name: 'Provisioning profile (.mobileprovision)' },
      ],
    });
    if (ios.length) {
      const p12 = ios.includes('p12') ? await input({ message: 'Path to the .p12 file:' }) : undefined;
      const mobileprovision = ios.includes('profile') ? await input({ message: 'Path to the .mobileprovision file:' }) : undefined;
      await runIosImport({ profile: name, p12, mobileprovision }, github, cwd);
    }
  }

  if (await confirm({ message: 'Show a status summary?', default: true })) {
    const { runStatus } = await import('./status.js');
    console.log('');
    await runStatus({}, github, cwd);
  }
  console.log('Commit rn-workflows.json and the workflow file, then run "Mobile build" from the Actions tab.');
}
