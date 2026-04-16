# VideoLM — Chrome Web Store Listing (Final)

> **Current version on CWS:** v0.3.0 (submitted 2026-04-17)
> **Note:** Contact email on the live CWS listing may differ from the `support@videolm.dev` shown in this file. See the CWS Developer Dashboard for the current value.

---

## Extension Name (max 75 chars)

```
VideoLM — AI Video Import to NotebookLM (Batch & Auto-Sync)
```
(60 chars)

---

## Summary / Short Description (max 132 chars)

**English:**
```
One-click import YouTube videos, playlists & channels into NotebookLM. Features smart deduplication, auto-batching, and AI workflows.
```
(132 chars)

**繁體中文：**
```
一鍵將 YouTube 影片、清單及頻道匯入 NotebookLM。支援智慧去重、自動分批匯入與 AI 研究工作流。
```

---

## Detailed Description (max 16,000 chars)

### English:

```
Transform your YouTube research workflow. VideoLM turns hours of manual link collection into seconds of automated magic.

Stop copy-pasting URLs one by one. VideoLM adds a native NotebookLM button directly on YouTube pages — click it to import the current video, an entire channel, or a full playlist into your notebook instantly.

Whether you're a researcher building a knowledge base, a student preparing for exams, or a podcaster curating source material, VideoLM bridges the gap between YouTube and NotebookLM's powerful AI analysis.


========================================
WHAT'S NEW IN v0.3.0 (Apr 2026)
========================================

RELIABILITY
• Automatic retry with exponential backoff for transient API errors (500, 502, 503, 504, 529, network failures, 429 rate limits)
• Honors Retry-After header on rate-limit responses
• Client errors (401, 400, 403) fail fast to avoid wasting quota

AI STRUCTURED MODE FIX
• Fixed content being stripped when GPT-4o-mini auto-wraps output in markdown code fences

AI CHAPTERS MODE FIX
• Fixed chapter duplication — each chapter now contains only its own time range segments
• Added defensive deduplication when AI returns overlapping chapter time ranges

TESTING
• Test coverage expanded from 277 to 346 tests across all AI modes


KEY FEATURES

One-Click Video Import
  Click the NotebookLM button on any YouTube video page to add it to your notebook. No tab switching, no URL copying. It just works.

Batch Channel & Playlist Import — The Bulk Powerhouse
  Not just single videos. Import ALL visible videos from a YouTube channel, playlist, or even search results in a single click. VideoLM automatically extracts every video URL from the page.

Smart Chunking — The 50-Source Solution
  YouTube channels with 100+ videos? NotebookLM limits each notebook to 50 sources. VideoLM is the only extension that automatically splits large collections across "Part 1, Part 2, Part 3..." notebooks — no manual intervention needed. It even detects existing Part notebooks and continues where it left off.

Smart Duplicate Detection (Deduplication)
  VideoLM checks your existing notebooks and skips videos you've already imported. No wasted quota, no duplicate sources cluttering your workspace. Supports CJK (Chinese, Japanese, Korean) notebook name matching for international users.

Auto-Create & Auto-Name Notebooks
  No need to open NotebookLM first. VideoLM automatically creates a new notebook named after the channel or playlist. Start importing from YouTube — your notebook is ready when you are.

Real-Time Progress Notifications
  Built with Shadow DOM technology for zero interference with YouTube. See floating toast notifications in the bottom-right corner showing importing progress, success confirmation with a direct link to your notebook, or clear error details.

Popup Quick Import
  Use the toolbar popup for a detailed view: see video metadata, transcript preview, and choose your import options before sending to NotebookLM.


USE CASES

  For Researchers: Build a comprehensive video knowledge base on any topic. Import an entire YouTube channel's library, then use NotebookLM to ask questions across all videos at once.

  For Students: Preparing for finals? Import your professor's entire lecture playlist into NotebookLM. Generate summaries, create study guides, and chat with the content.

  For Podcasters: Curate source videos for your next episode. Import them into NotebookLM, generate Audio Overviews, and use AI to find the most interesting talking points.

  For Content Creators: Research competitors, analyze trends, and organize inspiration. Import search results for any topic and let NotebookLM surface insights.


HOW IT WORKS

1. Install VideoLM from the Chrome Web Store
2. Browse YouTube as you normally do
3. Click the VideoLM button on any video, channel, or playlist page
4. VideoLM sends the content directly to NotebookLM
5. Open NotebookLM to chat with your videos, generate summaries, or create Audio Overviews


SUPPORTED PAGES

  YouTube video pages (/watch)
  YouTube channel pages (/@handle)
  YouTube playlist pages (/playlist)
  YouTube search results (/results)


PERMISSIONS — Minimal & Transparent

VideoLM requires only the permissions it needs:
  activeTab: Read the current YouTube page to extract video URLs
  storage: Save your import preferences locally
  scripting: Securely inject the "Add to NotebookLM" button and extract public metadata (titles, URLs) for better organization
  notifications: Show import completion alerts when you've navigated away
  Host access (youtube.com, notebooklm.google.com): Bridge communication between YouTube and NotebookLM. We only transfer publicly available metadata (URLs, titles) and do not access your private browsing data.

VideoLM does NOT collect, store, or transmit any personal data. All processing happens locally in your browser. No analytics, no tracking, no third-party servers.


COMING SOON (Pro)

  AI-powered video summaries before import
  Multi-platform support (Bilibili, Vimeo, and more)
  Custom preprocessing templates
  Priority support


FEEDBACK & SUPPORT

Found a bug or have a feature request? We'd love to hear from you.
Contact: support@videolm.dev
```

---

### 繁體中文：

```
VideoLM：您的 YouTube 轉 NotebookLM 智慧橋樑

別再浪費時間一個一個複製貼上網址了！VideoLM 專為 AI 研究者、學生與內容創作者設計，讓您在 YouTube 頁面直接「一鍵匯入」所有內容到 Google NotebookLM。


========================================
v0.3.0 更新內容（2026 年 4 月）
========================================

【更穩定】
• 新增自動重試機制：API 遇到暫時性錯誤（500、502、503、504、529、網路斷線、429 限流）會自動重試
• 支援 Retry-After 標頭：429 限流時依 API 建議時間等待
• 客戶端錯誤（401、400、403）不重試，立即報錯避免浪費配額

【AI 結構化修復】
• 修復 GPT-4o-mini 自動加程式碼圍欄導致 Notion 匯出內容消失的問題

【AI 章節拆分修復】
• 修復章節內容重複問題：原本每個章節都含完整逐字稿，現在精準切分對應時段
• 加入防禦性去重：AI 給出重疊時間範圍時自動合併

【測試】
• 測試覆蓋率大幅提升（277 → 346 項）


核心優勢

【一鍵匯入影片】
  在任何 YouTube 影片頁面點擊 NotebookLM 按鈕，即可加入筆記本。不需要切換分頁，不需要複製 URL。點一下就搞定。

【最強批次匯入】
  不只是單支影片，整個頻道、播放清單、甚至「搜尋結果」都能一鍵抓取。VideoLM 自動從頁面提取每個影片連結。

【突破 50 限制 — 智慧分批 (Smart Chunking)】
  遇到超過 50 部影片的大型清單？VideoLM 是唯一能自動建立「Part 1、Part 2、Part 3...」系列筆記本的擴充功能，完全不需手動干預。它還能偵測已存在的 Part 筆記本並自動續傳。

【智慧去重 (Deduplication)】
  自動檢查筆記本內已有的影片，重複的不匯入，節省您的寶貴配額。支援中日韓 (CJK) 筆記本名稱比對，國際用戶也能完美運作。

【自動建立與命名筆記本】
  不需要先打開 NotebookLM 手動建立筆記本。VideoLM 會自動以頻道或播放清單名稱建立新筆記本，並自動搜尋現有的 Part N 筆記本進行續傳，維持您的 NLM 首頁整潔不混亂。

【即時進度 Toast 通知】
  採用 Shadow DOM 技術，在 YouTube 頁面右下角即時顯示進度，不卡頓、不影響瀏覽。匯入成功後附筆記本直達連結。

【工具列快捷匯入】
  使用工具列彈出視窗查看影片資訊、字幕預覽，選擇匯入選項後再發送到 NotebookLM。


使用場景

  研究者：建立完整的影片知識庫。匯入整個 YouTube 頻道，然後用 NotebookLM 一次跨所有影片提問。

  學生：準備期末考？將教授的整個課程播放清單匯入 NotebookLM，自動生成摘要和學習指南。

  Podcaster：策劃下一集節目的素材。匯入參考影片，生成音訊總覽，讓 AI 找出最有趣的話題。

  內容創作者：研究競品、分析趨勢、整理靈感。匯入任何主題的搜尋結果，讓 NotebookLM 幫你挖掘洞察。


使用方式

1. 從 Chrome 線上應用程式商店安裝 VideoLM
2. 像平常一樣瀏覽 YouTube
3. 在任何影片、頻道或播放清單頁面點擊 VideoLM 按鈕
4. VideoLM 直接將內容發送到 NotebookLM
5. 開啟 NotebookLM 與影片對話、生成摘要或建立音訊總覽


支援頁面

  YouTube 影片頁 (/watch)
  YouTube 頻道頁 (/@handle)
  YouTube 播放清單頁 (/playlist)
  YouTube 搜尋結果 (/results)


權限說明 — 最小且透明

VideoLM 僅要求必要權限：
  activeTab：讀取當前 YouTube 頁面以提取影片 URL
  storage：在本機儲存匯入偏好設定
  scripting：安全注入「加入 NotebookLM」按鈕並提取公開資訊（標題、URL）
  notifications：匯入完成時顯示系統提醒
  主機存取 (youtube.com, notebooklm.google.com)：橋接 YouTube 與 NotebookLM 之間的通訊。僅傳輸公開可用的資訊（URL、標題），不存取您的私人瀏覽資料。

VideoLM 不會收集、儲存或傳輸任何個人資料。所有處理均在瀏覽器本機完成。無分析、無追蹤、無第三方伺服器。


即將推出（Pro 版）

  AI 影片摘要（匯入前預處理）
  多平台支援（Bilibili、Vimeo 等）
  自訂預處理範本
  優先客服支援


意見回饋

發現 Bug 或有功能建議？歡迎聯繫我們。
聯絡信箱：support@videolm.dev
```

---

## Single Purpose Description (max 1,000 chars)

```
VideoLM is a productivity bridge designed to streamline research workflows. Its single purpose is to automate the transfer of public YouTube metadata (URLs and titles) directly into Google NotebookLM. By eliminating manual copy-pasting, it enables users to organize video content for AI-powered analysis efficiently. It does not download or store any media files.
```
(362 chars)

---

## Category

`Productivity > Tools`

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
Required to securely inject the "Add to NotebookLM" button and extract public metadata (titles, durations) for better organization in your notebook.
```

**notifications:**
```
Displays system notifications when batch imports complete, especially when the user has navigated away from the YouTube tab during a long-running import.
```

**Host permission — youtube.com:**
```
Required to bridge communication between YouTube and NotebookLM. We only transfer publicly available metadata (URLs, captions) and do not access your private browsing data.
```

**Host permission — notebooklm.google.com:**
```
Required to bridge communication between YouTube and NotebookLM. We only transfer publicly available metadata (URLs, captions) and do not access your private browsing data.
```

---

## Privacy Policy

```
Privacy Policy for VideoLM

Last updated: 2026-04-03

VideoLM does not collect, store, or transmit any personal information.

Data handling:
- YouTube video URLs and page titles are processed locally in your browser
- NotebookLM session tokens are used temporarily for API communication and are never stored
- No user data is ever stored on external servers; all session information is transient and exists only during the active import task
- Import preferences are saved locally via Chrome's storage API
- No analytics, tracking, or telemetry data is collected
- No data is sent to any third-party server

The extension only communicates with:
1. youtube.com — to read video content from pages you visit
2. notebooklm.google.com — to import content into your notebooks

VideoLM does not download or store any media files (audio, video). It only transfers publicly available metadata (URLs and titles).

For questions, contact: support@videolm.dev
```

(Needs to be hosted at a public URL for CWS submission)
