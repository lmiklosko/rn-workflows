# Spike results

Design questions answered by experiment before building on them. Each entry records what was run and what it showed, so the temporary spike workflows can be deleted.

## 1. Environment secrets through a reusable workflow

**Question.** A caller repo invokes the public reusable workflow, and the job inside names a GitHub Environment. Does that job see the Environment's secrets and variables from the caller's repo?

**Setup.** The reusable workflow `spike-secrets.yml` reads two Environment secrets: one it does not declare, and one declared under `on.workflow_call.secrets`. It was called from a private repo under a different owner (`lumik-co/rnw-spike-caller`) and, as a control, from this repo itself. Run on 2026-11-13.

| Caller | How secrets are passed | Undeclared secret | Declared secret | Variable |
|---|---|---|---|---|
| Different owner | nothing | no | no | yes |
| Different owner | `secrets: inherit` | no | no | yes |
| Different owner | declared secret passed by name | no | **yes** | yes |
| Same owner | nothing | no | no | yes |
| Same owner | `secrets: inherit` | yes | yes | yes |

**Findings.**

- Environment variables always resolve. No passing is needed.
- `secrets: inherit` works only when caller and workflow share an owner. Across owners it is silently ignored: no error, just empty secrets.
- Across owners, a secret resolves when the reusable workflow declares it and the caller passes it by name. The value comes from the Environment even though the caller's own `secrets.NAME` is empty at that point, because the caller job has no Environment.

**Decision.**

- `build.yml` declares every secret it knows about under `on.workflow_call.secrets`, all optional.
- The caller workflow that `init` scaffolds passes each one by name. This form works for both same-owner and cross-owner callers, so it is the only form documented.
- App-specific secrets cannot be passed under arbitrary names. They go through one declared secret holding dotenv content, exported to the build.
- Non-secret per-environment values belong in Environment variables, which need no wiring.

## 2. Android signing without patching Gradle

**Question.** The Expo template wires the release build type to the debug keystore. Do AGP's injected signing properties, passed on the Gradle command line, override that, so the generated `android/app/build.gradle` needs no signing edit?

**Setup.** `spike-android-signing.yml` creates a fresh Expo app (Expo 58.0.25, React Native 0.88.1), runs `expo prebuild`, generates a throwaway keystore, and builds `assembleRelease bundleRelease` with:

```
-Pandroid.injected.signing.store.file=<keystore>
-Pandroid.injected.signing.store.password=<password>
-Pandroid.injected.signing.key.alias=<alias>
-Pandroid.injected.signing.key.password=<password>
```

It then compares the SHA-256 of the certificate in the keystore with the one that signed the APK and the AAB. Run on 2026-11-13.

**Findings.** Both the APK and the AAB are signed with the injected keystore. `build.gradle` still names `signingConfigs.debug` for the release build type; the injected properties win.

**Decision.** Android signing is done with injected properties only. The one edit to the generated project is `versionCode`.

**Caveat.** The passwords appear on the Gradle command line. In the real action they are passed through `ORG_GRADLE_PROJECT_*` environment variables instead, which Gradle reads as the same project properties without putting them in the process list.
