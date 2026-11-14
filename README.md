# rn-workflows

One shared GitHub Actions pipeline for building, signing and distributing Expo apps, plus a CLI that sets up the credentials each app repo needs.

**Status: work in progress. Builds and signing work; distribution is not built yet.**

## What works today

- Android and iOS builds of an Expo app that runs `expo prebuild` in CI, unsigned or signed.
- Signing without changes to the app's source: credentials come from GitHub Environment secrets, and the generated native projects are patched during the build.
- A CLI that sets a repository up and manages those credentials.

Not built yet: uploads to TestFlight, Firebase App Distribution and Google Play; release attachments and notifications; creating iOS certificates through the App Store Connect API. A signed iOS archive has not yet been run with Apple-issued credentials.

## Set up an app repository

Until the package is published to npm, run the CLI from a checkout of this repo (`npm install && npm run build`, then `node /path/to/rn-workflows/dist/cli.js`). It uses your `gh` login, or `GITHUB_TOKEN`.

```bash
rn-workflows init
```

This finds the Expo app, writes `rn-workflows.json` and `.github/workflows/mobile-build.yml`, creates one GitHub Environment per build profile, and offers to set up signing.

Signing credentials can be added or replaced at any time:

```bash
rn-workflows credentials android --profile production --generate
```

```bash
rn-workflows credentials android --profile production --keystore release.keystore --alias upload
```

```bash
rn-workflows credentials ios --profile production --p12 dist.p12 --mobileprovision store.mobileprovision
```

```bash
rn-workflows status
```

- `--generate` keeps the only recoverable copy of the keystore and its password under `.credentials/`, which is git-ignored. Move it to a password manager.
- The iOS command takes either file alone, so a renewed provisioning profile can be uploaded on its own. It is checked against the certificate already on record.
- Passwords are read from a prompt or from `ANDROID_KEYSTORE_PASSWORD` / `IOS_P12_PASSWORD`.

## Calling the workflow

App repos keep control of their own triggers and call the shared workflow:

```yaml
jobs:
  build:
    uses: lmiklosko/rn-workflows/.github/workflows/build.yml@main
    with:
      profile: production   # omit for an unsigned verification build
      platform: all         # ios | android | all
    secrets:
      ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
      # ...one line per secret; `rn-workflows init` writes the full list
```

Secrets are passed by name because `secrets: inherit` is ignored when the calling repository has a different owner; see [docs/spikes.md](docs/spikes.md). Per-app settings live in an optional `rn-workflows.json`, described by [`schema/rn-workflows.schema.json`](schema/rn-workflows.schema.json).

## Development

```bash
npm install
```

```bash
npm test
```
