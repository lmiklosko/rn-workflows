# rn-workflows

One shared GitHub Actions pipeline for building, signing and distributing Expo apps, plus a CLI that sets up the credentials each app repo needs.

**Status: work in progress. Builds, signing and delivery are implemented; delivery has not yet run against real store accounts.**

## What works today

- Android and iOS builds of an Expo app that runs `expo prebuild` in CI, unsigned or signed.
- Signing without changes to the app's source: credentials come from GitHub Environment secrets, and the generated native projects are patched during the build.
- A CLI that sets a repository up and manages those credentials.

- Delivery to Firebase App Distribution, TestFlight (with tester groups) and Google Play.

Not built yet: submitting to App Review, release attachments and notifications, creating iOS certificates through the App Store Connect API.

Not yet run against real accounts: a signed iOS archive with Apple-issued credentials, and every delivery target. Those paths are covered by tests against stand-in APIs only.

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

## Delivery

Each profile lists where its builds go:

```json
{
  "profiles": {
    "staging": {
      "deliver": { "firebase": { "groups": ["qa"] } }
    },
    "production": {
      "deliver": {
        "testflight": { "groups": ["Internal"] },
        "play": { "track": "internal" }
      }
    }
  }
}
```

Credentials for each target are stored per profile:

```bash
rn-workflows credentials firebase --profile staging --service-account firebase-key.json
```

```bash
rn-workflows credentials play --profile production --service-account play-key.json
```

```bash
rn-workflows credentials testflight --profile production --key AuthKey_ABC123DEFG.p8 --issuer-id <issuer-uuid>
```

- A target whose credentials are missing is skipped with a warning; the build still succeeds and its artifacts are kept.
- Firebase receives the APK and, for iOS, an ad hoc, development or enterprise build. TestFlight receives App Store builds only. Which kind an iOS build is comes from its provisioning profile.
- Firebase app IDs are read from the committed `google-services.json` and `GoogleService-Info.plist`.
- Google Play only accepts API uploads for an app whose first build was uploaded by hand in Play Console. Use `"status": "draft"` until the app has been published once.
- TestFlight groups are assigned in a separate Linux job that waits for Apple to process the build. External groups also need Beta App Review, which is not submitted for you.
- The `deliver` workflow input narrows the targets for one run, for example `deliver: none`.

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
