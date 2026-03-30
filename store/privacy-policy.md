# VideoLM Privacy Policy

**Effective Date:** 2026-03-30
**Last Updated:** 2026-03-30

## Overview

VideoLM ("the Extension") is a Chrome extension that imports YouTube video transcripts into Google NotebookLM. We are committed to protecting your privacy and collecting only the minimum data necessary for the extension to function.

## Data We Collect

- **Usage counters:** We track the number of imports performed per month solely to enforce plan limits (Free / BYOK / Pro). These counters are stored locally in your browser via `chrome.storage.local` and are not transmitted to any server, except for Pro plan users where counters are verified server-side.

## Data We Do NOT Collect

- Video content or URLs you visit
- YouTube transcripts (except as described under "Pro Plan" below)
- Personal information (name, email, browsing history)
- Analytics, telemetry, or behavioral tracking data
- Cookies or cross-site tracking identifiers

## API Keys (BYOK)

If you choose to use the Bring Your Own Key (BYOK) feature:

- Your OpenAI or Anthropic API keys are stored **locally** in `chrome.storage.local` on your device.
- Keys are sent **directly** from your browser to the respective AI provider (OpenAI or Anthropic) when you initiate an AI-powered import. They are **never** transmitted to or stored on our servers.

## Pro Plan

If you subscribe to the Pro plan:

- Transcripts are sent to our backend server for AI processing (summarization, structuring, translation).
- Transcripts are processed in-memory and are **not stored** after processing is complete.
- No transcript data is logged, cached, or retained.

## Third-Party Services

The Extension interacts with the following third-party services **only when explicitly initiated by the user**:

- **YouTube** — to extract publicly available video transcripts
- **Google NotebookLM** — to import processed content
- **OpenAI API** — only when the user configures a BYOK OpenAI key
- **Anthropic API** — only when the user configures a BYOK Anthropic key

We do not share any user data with third parties for advertising, analytics, or any other purpose.

## Data Storage

All extension data (settings, usage counters, API keys) is stored locally on your device using Chrome's built-in `chrome.storage.local` API. No data is stored on external servers except transient Pro plan processing as described above.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted in the Chrome Web Store listing and take effect immediately upon publication.

## Contact

If you have questions about this privacy policy, please open an issue on our GitHub repository or contact us through the Chrome Web Store developer page.
