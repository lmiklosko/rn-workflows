# rn-workflows

One shared GitHub Actions pipeline for building, signing and distributing Expo apps, plus a CLI that sets up the credentials each app repo needs.

**Status: early work in progress. Nothing here is ready to use yet.**

## What it will do

- Build Android and iOS from an Expo app that runs `expo prebuild` in CI.
- Sign without changes to the app's source: credentials come from GitHub Environment secrets.
- Optionally upload to TestFlight, Firebase App Distribution and Google Play.
- Run on your own GitHub Actions minutes or self-hosted runners.

App repos call a reusable workflow and keep control of their own triggers:

```yaml
jobs:
  build:
    uses: lmiklosko/rn-workflows/.github/workflows/build.yml@v1
    with:
      profile: production
      platform: all
    secrets: inherit
```

Per-app settings live in an optional `rn-workflows.json`; see [`schema/rn-workflows.schema.json`](schema/rn-workflows.schema.json).

## Development

```bash
npm install
npm test
```
