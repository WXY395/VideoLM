# VideoLM — Chrome Web Store Listing Draft

> 此為草稿，待審核後再提交。

---

## Extension Name (max 75 chars)

```
VideoLM — YouTube to NotebookLM, One-Click Import
```
(50 chars)

---

## Summary / Short Description (max 132 chars)

**English:**
```
Import YouTube videos, playlists & channels into NotebookLM with one click. Smart dedup, batch import, auto-create notebooks.
```
(126 chars)

**繁體中文（如需本地化）:**
```
一鍵將 YouTube 影片、播放清單和頻道匯入 NotebookLM。智慧去重、批次匯入、自動建立筆記本。
```

---

## Detailed Description (max 16,000 chars)

**English:**

```
VideoLM makes it effortless to send YouTube content into Google NotebookLM for AI-powered research, study, and podcast creation.

Stop copy-pasting URLs one by one. VideoLM adds a native NotebookLM button directly on YouTube pages — click it to import the current video, an entire channel, or a full playlist into your notebook instantly.

KEY FEATURES

One-Click Video Import
  Click the NotebookLM button on any YouTube video page to add it to your notebook. No tab switching, no URL copying.

Batch Channel & Playlist Import
  Import all visible videos from a YouTube channel or playlist in a single click. VideoLM automatically extracts every video URL from the page.

Smart Duplicate Detection
  VideoLM checks your existing notebooks and skips videos you've already imported. Supports CJK (Chinese, Japanese, Korean) notebook name matching.

Auto-Create Notebooks
  No need to manually create a notebook first. VideoLM automatically creates a new notebook named after the channel or playlist.

Auto-Split for Large Collections
  YouTube channels with 100+ videos? VideoLM automatically splits them across multiple notebooks (Part 1, Part 2, ...) to respect NotebookLM's 50-source limit.

Real-Time Progress Notifications
  See exactly what's happening with floating toast notifications — importing progress, success confirmation with a direct link to your notebook, or error details.

Popup Quick Import
  Use the toolbar popup for a detailed view: see video metadata, transcript preview, and choose your import options before sending to NotebookLM.

HOW IT WORKS

1. Install VideoLM from the Chrome Web Store
2. Browse YouTube as you normally do
3. Click the VideoLM button on any video, channel, or playlist page
4. VideoLM sends the content directly to NotebookLM
5. Open NotebookLM to chat with your videos, generate summaries, or create Audio Overviews

SUPPORTED PAGES

  - YouTube video pages (/watch)
  - YouTube channel pages (/@handle)
  - YouTube playlist pages (/playlist)
  - YouTube search results (/results)

PERMISSIONS

VideoLM requires minimal permissions:
  - activeTab: Read the current YouTube page to extract video URLs
  - storage: Save your import preferences locally
  - scripting: Extract video metadata from YouTube pages
  - notifications: Show import completion alerts
  - Host access to youtube.com and notebooklm.google.com: Required to read YouTube content and communicate with NotebookLM

VideoLM does NOT collect, store, or transmit any personal data. All processing happens locally in your browser.

COMING SOON (Pro)

  - AI-powered video summaries before import
  - Multi-platform support (Bilibili, Vimeo, and more)
  - Custom preprocessing templates
  - Priority support

FEEDBACK & SUPPORT

Found a bug or have a feature request? We'd love to hear from you.
```
(2,104 chars)

---

**繁體中文：**

```
VideoLM 讓你輕鬆將 YouTube 內容匯入 Google NotebookLM，用於 AI 研究、學習和 Podcast 製作。

不再一個一個複製貼上 URL。VideoLM 直接在 YouTube 頁面上加入 NotebookLM 按鈕——點一下就能將當前影片、整個頻道或完整播放清單匯入筆記本。

主要功能

一鍵匯入影片
  在任何 YouTube 影片頁面點擊 NotebookLM 按鈕，即可加入筆記本。不需要切換分頁，不需要複製 URL。

批次匯入頻道和播放清單
  一鍵匯入 YouTube 頻道或播放清單中所有可見的影片。VideoLM 自動從頁面提取每個影片連結。

智慧去重偵測
  VideoLM 會檢查現有筆記本，跳過已匯入的影片。支援中日韓（CJK）筆記本名稱比對。

自動建立筆記本
  不需要事先手動建立筆記本。VideoLM 會自動以頻道或播放清單名稱建立新筆記本。

大型集合自動拆分
  超過 100 部影片的頻道？VideoLM 自動拆分為多個筆記本（Part 1、Part 2...），遵守 NotebookLM 的 50 個來源上限。

即時進度通知
  浮動通知即時顯示匯入進度、成功確認（附筆記本直達連結）或錯誤詳情。

工具列快捷匯入
  使用工具列彈出視窗查看影片資訊、字幕預覽，選擇匯入選項後再發送到 NotebookLM。

使用方式

1. 從 Chrome 線上應用程式商店安裝 VideoLM
2. 像平常一樣瀏覽 YouTube
3. 在任何影片、頻道或播放清單頁面點擊 VideoLM 按鈕
4. VideoLM 直接將內容發送到 NotebookLM
5. 開啟 NotebookLM 與影片對話、生成摘要或建立音訊總覽

支援頁面

  - YouTube 影片頁 (/watch)
  - YouTube 頻道頁 (/@handle)
  - YouTube 播放清單頁 (/playlist)
  - YouTube 搜尋結果 (/results)

權限說明

VideoLM 僅要求最小權限：
  - activeTab：讀取當前 YouTube 頁面以提取影片 URL
  - storage：在本機儲存匯入偏好設定
  - scripting：從 YouTube 頁面提取影片資訊
  - notifications：顯示匯入完成提醒
  - 主機存取 youtube.com 和 notebooklm.google.com：讀取 YouTube 內容並與 NotebookLM 通訊

VideoLM 不會收集、儲存或傳輸任何個人資料。所有處理均在瀏覽器本機完成。

即將推出（Pro 版）

  - AI 影片摘要（匯入前預處理）
  - 多平台支援（Bilibili、Vimeo 等）
  - 自訂預處理範本
  - 優先客服支援

意見回饋

發現 Bug 或有功能建議？歡迎聯繫我們。
```

---

## Single Purpose Description (max 1,000 chars)

```
VideoLM imports YouTube video URLs into Google NotebookLM notebooks. It extracts video URLs from YouTube watch, channel, playlist, and search pages, then sends them to the user's NotebookLM account via NotebookLM's web interface. The extension's single purpose is to bridge YouTube content into NotebookLM for AI-powered analysis.
```
(331 chars)

---

## Category

**Recommended:** `Productivity > Tools`

(Same category as the #1 competitor "YouTube to NotebookLM")

---

## Permission Justifications

**activeTab:**
```
Required to read the current YouTube page URL and detect page type (video, channel, playlist, or search) so the extension knows what content to import.
```

**storage:**
```
Stores user preferences locally (duplicate detection strategy, import settings). No personal data is stored or transmitted.
```

**scripting:**
```
Executes scripts on YouTube pages to extract video metadata (title, URL list) and on NotebookLM pages to read notebook information (source count, existing URLs) for duplicate detection.
```

**notifications:**
```
Displays system notifications when batch imports complete, especially when the user has navigated away from the YouTube tab during a long-running import.
```

**Host permission — youtube.com:**
```
Required to inject the NotebookLM import button on YouTube pages and extract video URLs from the page DOM.
```

**Host permission — notebooklm.google.com:**
```
Required to communicate with NotebookLM's web API to create notebooks, list existing notebooks, and import video URLs as sources.
```

---

## Privacy Policy (Draft — needs a hosted URL)

```
Privacy Policy for VideoLM

Last updated: 2026-04-03

VideoLM does not collect, store, or transmit any personal information.

Data handling:
- YouTube video URLs and page titles are processed locally in your browser
- NotebookLM session tokens are used temporarily for API communication and are never stored
- Import preferences are saved locally via Chrome's storage API
- No analytics, tracking, or telemetry data is collected
- No data is sent to any third-party server

The extension only communicates with:
1. youtube.com — to read video content from pages you visit
2. notebooklm.google.com — to import content into your notebooks

For questions, contact: [YOUR_EMAIL]
```
