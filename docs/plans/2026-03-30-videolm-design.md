# VideoLM — AI Video to NotebookLM Chrome Extension 設計文件

**版本:** v1.0
**日期:** 2026-03-30
**狀態:** 已核准，待實作

---

## 1. Executive Summary

**定位：** 從 YouTube/TikTok 等影音平台到 NotebookLM (NLM) 的「高感知、低摩擦」知識橋接器。

**核心價值：** 超越單純「搬運」，透過 AI 預處理（結構化、語義分割、學術級翻譯）提升匯入 NLM 後的知識檢索品質。

**核心基點：** 非傳輸，而是過濾 (Not Transfer, but Pre-process) — VideoLM 的存在意義不是為了「移動資料」，而是為了「讓資料進入 NLM 前變得更好」。

**商業模式：** Freemium — 區隔「基礎搬運」與「AI 深度加工」。

---

## 2. 競爭分析

### 市場格局

| 工具 | 用戶數 | YouTube | TikTok | 小紅書 | AI 處理 | 直接匯入NLM |
|------|--------|---------|--------|--------|---------|-------------|
| NotebookLM Web Importer | 200K+ | ✅ | ❌ | ❌ | ❌ | ✅ |
| NotebookLM Tools | 50K+ | ✅ | ❌ | ❌ | ❌ | ✅ |
| YouTube to NotebookLM | - | ✅ | ❌ | ❌ | ❌ | ✅ |
| BibiGPT | - | ✅ | ✅ | ✅ | ✅ | ❌ |
| **VideoLM (我們)** | **新** | **✅** | **V1.1** | **V2** | **✅** | **✅** |

### 競爭優勢

1. **交互效率：** 官方匯入 5-6 步 → VideoLM 一鍵直達
2. **資料品質：** 解決 NLM 直接匯入時字幕雜亂、缺乏結構的痛點
3. **語義分割 (Semantic Chunking)：** 核心黏著點，比「一鍵匯入」更強
4. **生態位卡位：** NLM 成長紅利期，建立「影音知識轉筆記 = VideoLM」心智佔位

---

## 3. 整體架構

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Extension (Manifest V3)        │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Popup   │  │Content Scripts│  │  Background       │  │
│  │  (React) │  │(per platform) │  │  Service Worker   │  │
│  │          │  │              │  │                   │  │
│  │ • 匯入UI  │  │ • YouTube    │  │ • API 路由       │  │
│  │ • 設定    │  │ • NotebookLM │  │ • 狀態管理       │  │
│  │ • 摘要預覽│  │ • (TikTok*)  │  │ • 訊息橋接       │  │
│  └──────────┘  └──────────────┘  └───────┬───────────┘  │
│                                          │               │
└──────────────────────────────────────────┼───────────────┘
                                           │
                                    HTTPS API calls
                                           │
                              ┌────────────▼────────────┐
                              │   Cloudflare Workers     │
                              │   (Serverless Backend)   │
                              │                          │
                              │ • /api/summarize         │
                              │ • /api/transcribe        │
                              │ • /api/translate         │
                              │ • /api/config (動態配置)  │
                              │ • /api/auth (用戶認證)    │
                              └──────────────────────────┘
```

### 技術棧

- **Extension:** TypeScript + React (Popup/Options) + Manifest V3
- **後端:** Cloudflare Workers (Serverless)
- **AI 模型:** Claude Haiku / GPT-4o-mini (Pro)；用戶自選 (BYOK)
- **語音轉文字:** OpenAI Whisper API ($0.006/min)
- **打包:** Vite + CRXJS

### Manifest V3 權限

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "storage", "scripting"],
  "host_permissions": [
    "https://www.youtube.com/*",
    "https://notebooklm.google.com/*"
  ]
}
```

> MVP 僅聲明 YouTube + NLM 權限。TikTok/小紅書在後續版本加入。

---

## 4. 核心元件設計

### 4.1 YouTube 字幕擷取器 (`youtube-extractor.ts`)

**擷取策略（優先順序）：**

1. 讀取 `ytInitialPlayerResponse.captions.captionTracks[].baseUrl` → Fetch XML 字幕
2. 攔截 `/api/timedtext` 網路請求
3. Fallback: 後端 Whisper API 轉錄（僅無字幕影片）

**輸出資料結構：**

```typescript
interface VideoContent {
  platform: 'youtube' | 'tiktok' | 'xiaohongshu';
  videoId: string;
  title: string;
  author: string;
  duration: number;
  language: string;
  chapters?: Chapter[];
  transcript: TranscriptSegment[];
  metadata: { publishDate: string; viewCount: number; tags: string[] };
}

interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}
```

### 4.2 AI 預處理引擎 (`ai-processor.ts`)

**四種匯入模式：**

| 模式 | 說明 | 匯入到 NLM 的內容 |
|------|------|-------------------|
| Raw | 原始字幕 | 純文字轉錄稿 |
| Structured | AI 結構化 | 大綱 + 重點 + 時間戳索引 |
| Summary | AI 精簡摘要 | 核心觀點 + 術語表 |
| Chapters | 章節分割 | 每個章節獨立 Source |

**結構化摘要 Prompt 策略要點：**

- 為 NLM 的 RAG 系統優化，每個段落是「自包含知識單元」
- 使用語義描述性 H2/H3 標題（非「第一段/第二段」）
- 關鍵詞自然出現在段落前 50 字內
- 帶時間戳引用的關鍵論點
- 區分「事實陳述」vs「觀點/意見」
- 移除語氣詞、合併碎片句、修正語音辨識錯誤

**語義章節分割策略：**

- 每章 300-2000 字（RAG 最佳 chunk 大小）
- 教學類 → 按知識點分割
- 訪談類 → 按討論主題分割
- 新聞類 → 按報導事件分割
- 短影片 (<5min) → 1-2 章節即可

### 4.3 NotebookLM 整合層 (`notebooklm-bridge.ts`)

**三層 Fallback 策略：**

| Tier | 方法 | 速度 | 穩健性 | 說明 |
|------|------|------|--------|------|
| 1 | Fetch Replay | ~500ms/source | 中 | 攔截 NLM 內部 API，重播請求 |
| 2 | DOM Automation | ~1.5s/source | 高 | 程式化點擊 UI，Angular-safe 輸入模擬 |
| 3 | Clipboard Manual | 即時 | 最高 | 複製到剪貼簿，提示手動貼上 |

**動態配置中心 (`/api/config`)：**

- 後端維護 NLM 頁面的 CSS 選擇器和 API 端點映射
- Extension 啟動時拉取最新配置
- NLM UI 更新時只改後端配置，不需更新插件 → 秒級修復
- 包含緊急開關（可遠端停用 Fetch 攔截或 DOM 自動化）

**Fetch 攔截器關鍵設計：**

- Session Token 過期偵測（25 分鐘警告，30-60 分鐘需刷新）
- Headers 白名單清洗（只保留必要 auth headers）
- 多策略 DOM 選擇器（CSS → ARIA → 結構化推斷）
- Angular-safe 輸入：模擬完整 keydown→input→keyup 事件鏈

### 4.4 串流式漸進匯入 (`progressive-importer.ts`)

**Pipeline 模式：處理完一章就匯入一章**

```
Chapter 1: [AI 處理] → [匯入 NLM] ✅
Chapter 2:              [AI 處理] → [匯入 NLM] ✅
Chapter 3:                           [AI 處理] → [匯入 NLM]
```

- 極大提升使用者感知速度（每 3-5 秒就有一個 Source 出現）
- 錯誤隔離：第 N 章失敗不影響前 N-1 章
- 即時進度回報（帶進度條和章節名稱）

### 4.5 重複內容偵測 (`duplicate-detector.ts`)

**偵測策略：**

1. 精確匹配：影片 ID 存在於現有 Source 的 URL 或標題中
2. 模糊匹配：標題 Levenshtein 相似度 > 0.8

**處理選項：** 覆蓋更新 / 另存為新 Source / 跳過

### 4.6 算力雙軌制 (`ai-provider-manager.ts`)

**Provider 優先級：**

1. `window.ai` (Gemini Nano) — 成本 $0，延遲最低（未來）
2. Pro 內建算力 — Cloudflare Workers → Claude Haiku / GPT-4o-mini
3. BYOK — 用戶自己的 API Key，直接從 Extension 呼叫（不經過我們後端）
4. No AI — 只提供 Raw 模式（免費、無 Key）

**BYOK 安全：**

- API Key 加密存儲在 `chrome.storage.local`
- API 呼叫直接從 Extension 發出，不經過我們的伺服器
- 零隱私風險、零 API 成本

---

## 5. 功能門控

```
Free:
  ├── Raw 匯入: 無限
  ├── AI 功能: ❌ (需 BYOK 或升級 Pro)
  ├── 批次匯入: 每月 3 次
  └── 總匯入次數: 每月 10 次

Free + BYOK:
  ├── Raw 匯入: 無限
  ├── AI 摘要/分割/翻譯: ✅ (用自己的 Key)
  ├── 批次匯入: 每月 10 次
  └── 總匯入次數: 每月 30 次

Pro ($6/月):
  ├── Raw 匯入: 無限
  ├── AI 摘要/分割/翻譯: ✅ (內建算力)
  ├── 批次匯入: 無限
  ├── 總匯入次數: 無限
  ├── 自訂 AI 模板: ✅
  └── 優先修復: ✅
```

---

## 6. UI 設計

### Popup 主介面

```
┌─────────────────────────────────┐
│  🎬 VideoLM                     │
│─────────────────────────────────│
│                                 │
│  影片：How AI Changes...        │
│  時長：45:30 | 章節：8          │
│  語言：英文 | 字幕：✅           │
│                                 │
│  ── 匯入模式 ──                 │
│  ○ 原始字幕                     │
│  ● AI 結構化摘要        ← 預設  │
│  ○ 精簡摘要                     │
│  ○ 按章節分割                   │
│                                 │
│  ── 翻譯 ──                     │
│  □ 翻譯成中文                   │
│                                 │
│  [選擇筆記本 ▾]                 │
│                                 │
│  [ 📤 匯入到 NotebookLM ]      │
│                                 │
│  本月剩餘：7/10 次 (免費版)      │
└─────────────────────────────────┘
```

### 匯入進度（串流模式）

```
┌─────────────────────────────────┐
│  📤 匯入進度                     │
│                                 │
│  ✅ Ch.1: 神經網路基礎   [已匯入] │
│  ✅ Ch.2: 反向傳播原理   [已匯入] │
│  🔄 Ch.3: 優化器比較     [AI中]  │
│  ⏳ Ch.4: 實作演示       [等待]  │
│                                 │
│  ████████░░░░░░  3/5 (60%)      │
│  預計剩餘：8 秒                  │
└─────────────────────────────────┘
```

### 重複偵測提示

```
┌─────────────────────────────────┐
│  ⚠️ 重複偵測                    │
│                                 │
│  此影片已存在於筆記本中：        │
│  「AI 入門教學 — 第三章」        │
│                                 │
│  ○ 覆蓋更新                     │
│  ○ 另存為新 Source               │
│  ○ 跳過                         │
│                                 │
│  [ 確認 ]                       │
└─────────────────────────────────┘
```

---

## 7. 風險與對策

### 高風險

| 風險 | 對策 |
|------|------|
| NLM UI 更新導致整合失效 | 動態配置中心 + 三層 Fallback + 後端秒級修復 |
| Google 推出官方 API/功能覆蓋 | AI 預處理 + 跨平台是官方不做的差異化 |
| TikTok/小紅書反爬升級 | MVP 不依賴這些平台；後續加入時用降級策略 |

### 中風險

| 風險 | 對策 |
|------|------|
| CWS 審核被拒 | 最小權限 (activeTab)、完整隱私政策 |
| AI API 成本失控 | BYOK 雙軌制、Free 用戶限額、Gemini Nano 預留 |
| 免費競品擠壓定價 | AI 品質是付費差異化，非基礎功能 |

---

## 8. 產品路線圖

```
MVP (4-6 週)
├── YouTube 字幕擷取 + NotebookLM 三層 Fallback 整合
├── AI 智能摘要預處理（結構化/精簡/原始 三模式）
├── 影片章節智能分割（YouTube 標記 + AI 語義分割）
├── 串流式漸進匯入
├── 重複內容偵測
├── BYOK 算力雙軌制
└── 動態配置中心

V1.1 (2-3 週後)
├── 播放清單 → 課程筆記（結構化批次匯入）
├── 多語翻譯匯入
├── TikTok 基礎支援（文字擷取 + Whisper 轉錄）
└── Pro 付費方案上線

V2 (視市場反饋)
├── 小紅書支援
├── Podcast RSS 訂閱自動匯入
├── 自訂 AI 模板
├── window.ai (Gemini Nano) on-device AI
└── 視覺關鍵幀擷取（投影片/白板 OCR）
```

---

## 9. 成本估算

### 開發

- 一次性費用：~$20 (CWS 帳號 + 域名)
- 開發時間：~25-35 人天（1-1.5 個月全職）
- 開發期 API 測試：~$10-20

### 營運（月成本 vs 用戶規模）

| 用戶數 | 月成本 | 損益平衡點 (Pro $6/月, 5% 轉換) |
|--------|--------|-------------------------------|
| 100 | $4-11 | 已盈利 |
| 1,000 | $40-115 | 月淨利 ~$185-260 |
| 5,000 | $205-570 | 月淨利 ~$930-1,295 |
| 10,000 | $420-1,150 | 月淨利 ~$1,850-2,580 |

---

## 10. 推廣策略

### 冷啟動 (0→1000)
- CWS 搜索優化（名稱含 NotebookLM + YouTube + AI）
- Reddit (r/NotebookLM, r/productivity) + Product Hunt
- Twitter demo 短影片 + YouTube 教學

### 成長期 (1000→10000)
- KOL 合作（教育/生產力 YouTuber）
- SEO 長尾文章
- 產品內推薦獎勵機制

### 護城河
- CWS 評分累積 (4.5+)
- 品牌心智佔位
- AI 摘要模板持續優化

---

## 11. 前瞻性預留

- **window.ai (Gemini Nano):** AIProvider 接口已預留，可零成本 on-device AI
- **多模態處理:** 視覺關鍵幀擷取（投影片偵測）將影像資訊轉為文本
- **API 價格走勢:** 預期每半年減半，訂閱價格已預留利潤擴張空間
- **NLM Enterprise API:** 如果開放個人版，立即切換到官方 API
