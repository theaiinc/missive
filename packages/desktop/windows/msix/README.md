# Missive for the Microsoft Store (MSIX)

`.github/workflows/msix-missive.yml` builds `Missive.exe` with Tauri
(`--no-bundle`, plus `src-tauri/tauri.microsoftstore.conf.json`), lays it out with
this folder's `Package.appxmanifest` and `Assets/`, and packs an **unsigned**
`Missive_<version>_x64.msix` with the Windows SDK's `makeappx.exe`. The Store
signs packages itself, so no certificate or secret is needed.

Run it from the Actions tab (**MSIX (Microsoft Store)** > Run workflow), or push
to `feat/msix-store`. The package is the run's `Missive_<version>_x64_msix`
artifact.

## Partner Center values -> repository variables

Reserve the app name in Partner Center, then open the app's
**Product management > Product identity** page. Copy its values into
GitHub: **Settings > Secrets and variables > Actions > Variables** (variables,
not secrets; none of them is secret).

| Product identity field                      | Repository variable           | Manifest attribute                    |
| ------------------------------------------- | ----------------------------- | ------------------------------------- |
| `Package/Identity/Name`                     | `MSIX_IDENTITY_NAME`          | `Identity@Name`                       |
| `Package/Identity/Publisher` (`CN=...`)     | `MSIX_PUBLISHER`              | `Identity@Publisher`                  |
| `Package/Properties/PublisherDisplayName`   | `MSIX_PUBLISHER_DISPLAY_NAME` | `Properties/PublisherDisplayName`     |

Copy them exactly (case and dots matter); the Store rejects a package whose
identity doesn't match. Without the variables the workflow uses test defaults
(`TheAITechnology.Missive`, `CN=00000000-0000-0000-0000-000000000000`,
`THE AI TECHNOLOGY COMPANY LIMITED`), which build fine but won't be accepted.

The version is `tauri.conf.json`'s `version` plus `.0` (e.g. `0.1.0` ->
`0.1.0.0`); the Store needs the fourth part to be 0. Bump `version` for every
new submission: the Store refuses a version it has already seen.

## Submitting

1. Set the three variables, run the workflow, download and unzip the artifact.
2. In Partner Center, start a submission for Missive. Under **Packages**, upload
   `Missive_<version>_x64.msix`.
3. Fill in the rest (pricing, properties, age ratings, store listing). Missive
   uses `runFullTrust`, a restricted capability: under **Submission options**,
   explain it's a desktop (Win32) app that needs full trust to run.
4. Submit for certification.

To try the package on a PC before submitting, it has to be signed (an unsigned
MSIX won't install): sign it with a self-signed certificate whose subject is the
same `CN=...` as `MSIX_PUBLISHER`, or install the unpacked layout with
`Add-AppxPackage -Register msix-layout\AppxManifest.xml` in Developer Mode.

## Files

- `Package.appxmanifest` - the manifest, with `__MSIX_*__` placeholders the
  workflow fills in. `missive://` is registered as a protocol, matching
  `plugins.deep-link` in `tauri.conf.json` (sign-in and account connections
  come back to the app that way).
- `Assets/` - tile and Store logos, made from `packages/web/public/icon-512.png`
  (the same source as `src-tauri/icons`) with `pnpm tauri icon <png> -o <dir>`.
  There's no wide (310x150) tile, so the manifest doesn't declare one.
