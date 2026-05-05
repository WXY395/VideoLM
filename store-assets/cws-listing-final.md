# VideoLM - Chrome Web Store Listing

> Draft updated for server entitlement/quota and Pro readiness.
> Current release package: v0.4.0.

---

## Extension Name

```text
VideoLM - AI Video Import to NotebookLM
```

## Short Description

```text
Import YouTube videos, playlists, channels, and search results into NotebookLM with smart batching, dedup, and exports.
```

## Detailed Description

```text
VideoLM turns YouTube research into NotebookLM-ready source collections.

Stop copying URLs one by one. VideoLM adds a NotebookLM button directly on YouTube pages so you can import the current video, visible search results, an entire playlist, or a channel page into NotebookLM with fewer manual steps.

KEY FEATURES

One-click video import
  Add the current YouTube video to NotebookLM from the YouTube page.

Batch channel, playlist, and search import
  Import visible YouTube videos from channels, playlists, and search results in one workflow.

Smart chunking
  NotebookLM has source limits. VideoLM can split large collections into Part 1, Part 2, Part 3, and continue importing across multiple notebooks.

Smart duplicate detection
  VideoLM checks existing notebooks and local source records to reduce duplicate sources and wasted import quota.

Auto-create and auto-name notebooks
  Start from YouTube and let VideoLM create a NotebookLM notebook based on the channel, playlist, or page title.

Progress notifications
  Floating progress toasts keep you informed during long imports without interrupting YouTube.

Notion and Obsidian export helpers
  After NotebookLM generates a response, VideoLM can copy or download that response in research-friendly Markdown formats for Notion or Obsidian.

Free and Pro support
  VideoLM uses server-side license and quota validation for the official extension flow. Free users can import up to the monthly quota shown in the extension. Pro users can unlock higher limits and bundled AI features where available.

USE CASES

Researchers
  Build topic-specific video knowledge bases and ask NotebookLM questions across many sources.

Students
  Import lecture playlists into NotebookLM for study guides, summaries, and review.

Podcasters
  Collect source videos for episode research and turn them into NotebookLM notebooks.

Creators and analysts
  Organize competitor research, trend analysis, and source material from YouTube.

SUPPORTED PAGES

  YouTube video pages (/watch)
  YouTube channel pages (/@handle)
  YouTube playlist pages (/playlist)
  YouTube search results (/results)
  NotebookLM notebook pages for export helpers

PRIVACY SUMMARY

VideoLM does not sell personal data, run ad tracking, or collect analytics.

The extension stores preferences, duplicate cache, source index, optional BYOK API keys, license settings, and quota status in Chrome storage. It may communicate with the VideoLM backend for license validation, quota enforcement, and optional bundled Pro AI features.

VideoLM communicates with YouTube and NotebookLM only to provide the user-facing import/export features. See the full privacy policy for details.

SUPPORT

Contact: studiotest187@gmail.com
```

---

## Single Purpose Description

```text
VideoLM is a productivity bridge for research workflows. Its single purpose is to help users transfer YouTube video sources into Google NotebookLM and export NotebookLM responses into research-friendly formats. It does not download or store media files.
```

## Category

```text
Productivity > Tools
```

## Permission Justifications

### activeTab

```text
Required to read the current YouTube page URL and page type when the user invokes VideoLM.
```

### storage

```text
Required to store import preferences, duplicate detection cache, source index, export settings, license settings, and mirrored quota status.
```

### scripting

```text
Required to inject the NotebookLM import button on YouTube pages and export controls on NotebookLM pages.
```

### notifications

```text
Required to show completion or error notifications for long-running batch imports.
```

### alarms

```text
Required to keep the extension service worker alive during long-running batch imports.
```

### Host permission - youtube.com

```text
Required to read supported YouTube pages and collect the URLs/titles selected by the user for import.
```

### Host permission - notebooklm.google.com

```text
Required to submit selected YouTube URLs into NotebookLM and provide Notion/Obsidian export helpers on NotebookLM responses.
```

## Privacy Policy Summary

```text
VideoLM does not sell personal data, run ad tracking, or collect analytics.

The extension processes YouTube URLs, titles, channel names, visible NotebookLM notebook/source/response content, import preferences, export settings, license keys, entitlement tokens, and quota status only to provide its import, export, license, quota, and optional AI features.

Local settings and caches are stored in Chrome storage. License and quota validation may be performed by the VideoLM backend. Optional BYOK API keys are stored locally and used only when the user enables BYOK AI features.

For questions, contact studiotest187@gmail.com.
```
