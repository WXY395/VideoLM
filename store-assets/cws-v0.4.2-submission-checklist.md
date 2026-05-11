# VideoLM v0.4.2 CWS Submission Checklist

## Package

- Upload file: `F:\Youtube to NotebookLM\videolm-v0.4.2-cws.zip`
- Manifest version: `0.4.2`
- Package contents: built `dist` files only.
- Package scan: no repo source, backend, `.git`, `.claude`, output, competitor analysis, screenshots, old zip files, secrets, API keys, or internal notes.

## Release Notes

```text
Fixes server quota validation by switching to the deployed VideoLM backend and improving import status feedback.
Adds optional Google Gemini BYOK support.
Updates privacy and permission disclosures for Gemini BYOK and backend quota validation.
```

## Permission Justifications

Use the current text in `store-assets/cws-listing-final.md`.

Changed or newly relevant item:

```text
Required only when the user enables Gemini BYOK AI features to call the selected Google Gemini model with the user-provided API key.
```

This applies to:

```text
https://generativelanguage.googleapis.com/*
```

## Privacy / Data Disclosure Notes

- Privacy policy file updated locally: `privacy.html`
- Contact email: `studiotest187@gmail.com`
- Backend disclosed: `videolm-api.a0970292729.workers.dev`
- Optional BYOK providers disclosed: OpenAI, Anthropic, Google Gemini
- No analytics or ad tracking.
- BYOK API keys are stored locally in Chrome storage and used only when the user enables BYOK AI features.

Before final CWS submission, make sure the hosted privacy URL reflects this local `privacy.html`.

## Verification Completed

- `npm.cmd test`: 35 files / 409 tests passed.
- `npm.cmd run build`: passed.
- Zip structure check: passed.
- Zip sensitive/internal scan: passed.
- Dist manifest check: version `0.4.2`; permissions and host permissions match expected scope.
- Live backend register/reserve check: passed with `remaining: 99` after one free-plan reserve.

## Expected Review Notes

- This release adds a new host permission for Google Gemini API. The justification is BYOK-only and user-enabled.
- This release changes the backend URL from the invalid `api.videolm.workers.dev` default to the deployed Worker backend.
- The old backend URL may still appear in the built service worker only as a legacy-settings migration string.
