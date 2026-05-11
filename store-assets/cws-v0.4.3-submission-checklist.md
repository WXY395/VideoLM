# VideoLM v0.4.3 CWS Submission Checklist

## Package

- Upload file: `F:\Youtube to NotebookLM\videolm-v0.4.3-cws.zip`
- Manifest version: `0.4.3`
- Package contents: built `dist` files only.
- Package scan: no repo source, backend, `.git`, `.claude`, output, competitor analysis, screenshots, old zip files, secrets, API keys, or internal notes.

## Release Notes

```text
Moves the VideoLM backend disclosure and default settings to the branded workers.dev endpoint.
Migrates older backend URLs from api.videolm.workers.dev and videolm-api.a0970292729.workers.dev to videolm-api.videolm.workers.dev.
Keeps Gemini BYOK, support diagnostics, and server quota behavior from v0.4.2.
```

## Permission Justifications

Use the current text in `store-assets/cws-listing-final.md`.

Changed or newly relevant item:

```text
Host permission - videolm-api.videolm.workers.dev
Required to contact the VideoLM backend for license validation, quota enforcement, entitlement checks, and optional bundled Pro AI features.
```

## Privacy / Data Disclosure Notes

- Privacy policy file updated locally: `privacy.html`
- Contact email: `studiotest187@gmail.com`
- Backend disclosed: `videolm-api.videolm.workers.dev`
- Legacy backend URLs migrated locally: `api.videolm.workers.dev`, `videolm-api.a0970292729.workers.dev`
- Optional BYOK providers disclosed: OpenAI, Anthropic, Google Gemini
- No analytics or ad tracking.
- BYOK API keys are stored locally in Chrome storage and used only when the user enables BYOK AI features.
- Hosted privacy URL synced on 2026-05-10: `https://wxy395.github.io/VideoLM/privacy.html`
- GitHub main privacy sync commit: `7bce64cbde0c89597319e6fab7400d8c9072e1f4`

## Release Gate

- CWS v0.4.3 was approved on 2026-05-11.
- Cloudflare account subdomain was changed to `videolm` on 2026-05-10.
- Before submission, verify `https://videolm-api.videolm.workers.dev` resolves and live `register` plus `reserve` requests pass.
- The old personal-identifying URL `videolm-api.a0970292729.workers.dev` returned `ENOTFOUND` after cutover, so v0.4.2 users that still point to that URL should update to v0.4.3 as soon as it is approved.
- Public CWS listing check on 2026-05-10 still showed `0.1.0` for `fceedhmcaeenaappocciedinlainehfm`; verify CWS Developer Dashboard separately because public page state may not match the approved dashboard state.

## Verification Completed

- `npm.cmd test`: 35 files / 414 tests passed.
- `npm.cmd run build`: passed.
- Backend `npm.cmd run build`: passed.
- `git diff --check`: passed.
- Zip structure check: passed for `videolm-v0.4.3-cws.zip` (23 built files, no source maps, repo source, backend, `.git`, `.claude`, output, competitor analysis, old zip files, or internal notes).
- Zip sensitive/internal scan: passed for high-risk token/secret patterns.
- Dist manifest check: version `0.4.3`; permissions and host permissions match expected scope, including `https://videolm-api.videolm.workers.dev/*` for backend `fetch()` from the extension service worker / extension pages.
- Live backend register/reserve check on old deployed backend `videolm-api.a0970292729.workers.dev`: passed before cutover with `remaining: 99` after one free-plan reserve.
- Branded backend DNS preflight: `videolm-api.videolm.workers.dev` resolved after Cloudflare cutover.
- Branded backend live register/reserve check: passed on 2026-05-10 after propagation (`register 200`, `reserve 200`, `allowed: true`, `remaining: 99`).
- Legacy URL post-cutover check: `videolm-api.a0970292729.workers.dev` returned `ENOTFOUND`.
- GitHub Pages privacy URL check: passed on 2026-05-10; public page shows `Last updated: May 10, 2026`, includes `videolm-api.videolm.workers.dev`, and no longer includes `videolm-api.a0970292729.workers.dev`.
- Final pre-submission check on 2026-05-11 local time: extension `npm.cmd test` passed with 35 files / 414 tests, extension `npm.cmd run build` passed, backend `npm.cmd run build` passed, and live branded backend `register` plus `reserve` passed (`register 200`, `reserve 200`, `allowed: true`, `remaining: 99`).
- After adding the backend host permission, extension `npm.cmd test` passed again with 35 files / 414 tests, extension `npm.cmd run build` passed again, and `git diff --check` passed with line-ending warnings only.
- Release closure verification on 2026-05-11 local time: extension `npm.cmd test` passed with 35 files / 414 tests, extension `npm.cmd run build` passed, backend `npm.cmd run build` passed, `git diff --check` passed, zip structure/secret scan passed, and live branded backend `register` plus `reserve` passed (`register 200`, `reserve 200`, `allowed: true`, `remaining: 99`).
- `videolm-v0.4.3-cws.zip` was rebuilt after the closure build on 2026-05-11 local time; current size is 137,951 bytes with 23 entries. `videolm-v0.4.2-cws.zip` was not modified.

## Expected Review Notes

- This release changes only the disclosed/default backend domain and local settings migration around the backend endpoint.
- The old backend URLs may still appear in the built service worker only as legacy-settings migration strings.

## Post-Approval Closure

- CWS public page check on 2026-05-11 returned HTTP 200 and included `0.4.3`.
- Installed Chrome extension check on 2026-05-11 found `Default\Extensions\fceedhmcaeenaappocciedinlainehfm\0.4.3_0\manifest.json` with manifest version `0.4.3`.
- Installed bundle URL check found `videolm-api.videolm.workers.dev` plus the two legacy migration URLs in built JS.
- Installed CWS manifest did not include `https://videolm-api.videolm.workers.dev/*`; it included NotebookLM, YouTube, and Gemini host permissions. Backend CORS preflight for `chrome-extension://fceedhmcaeenaappocciedinlainehfm` returned `204` with `Access-Control-Allow-Origin` set to the extension origin.
- Follow-up decision for v0.4.4: decide whether to keep backend communication CORS-only to avoid an extra host permission prompt, or submit an explicit backend host permission for stricter extension permission alignment.
