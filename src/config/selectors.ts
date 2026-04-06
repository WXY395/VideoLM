/**
 * Centralized CSS Selector Registry
 * ===================================
 * Single source of truth for ALL DOM selectors used across the extension.
 *
 * WHY: YouTube changes its DOM every 2-4 weeks. Having selectors scattered
 * across youtube.ts and service-worker.ts means a single YouTube update can
 * break multiple files silently. This file ensures:
 *   1. One place to update when YouTube changes its DOM
 *   2. Array-based fallbacks tolerate A/B testing variants
 *   3. Service worker executeScript funcs receive selectors via `args`
 *      (they run in MAIN world and cannot import modules)
 *
 * CONVENTION:
 *   - Arrays = fallback chain (tried in order, first match wins)
 *   - Strings = single selector (no fallback needed / combined via CSS comma)
 *   - All values must be JSON-serializable (no RegExp, no functions)
 *     because executeScript `args` use structured clone.
 */

// ============================================================================
// YouTube Selectors
// ============================================================================

export const YT = {
  // --------------------------------------------------------------------------
  // Button injection points — where VideoLM buttons get inserted
  // Arrays are fallback chains: first match wins.
  // --------------------------------------------------------------------------
  INJECT: {
    /** Watch page: owner row (channel name + subscribe area) */
    VIDEO: [
      'ytd-watch-metadata #owner',
      '#above-the-fold #owner',
    ],

    /** Channel page: header action buttons area */
    CHANNEL: [
      'yt-page-header-renderer yt-flexible-actions-view-model', // 2024+ layout
      'yt-page-header-renderer #buttons',                       // alternate 2024
      '#channel-header-container #buttons',                     // legacy layout
      '#owner',                                                 // last resort
    ],

    /** Playlist page: header action bar */
    PLAYLIST: [
      'ytd-playlist-header-renderer .metadata-action-bar',
      'ytd-playlist-header-renderer #top-level-buttons-computed',
      '.immersive-header-content .metadata-action-bar',
    ],

    /** Search results page: filter/sort row area */
    SEARCH: [
      'ytd-search-sub-menu-renderer',                           // Sort/Filter row — always present
      'ytd-two-column-search-results-renderer #primary',        // stable left column
      'ytd-section-list-renderer',                               // last resort
    ],
  },

  // --------------------------------------------------------------------------
  // Video link extraction — CSS selectors for <a> elements containing video URLs
  // Used by both content script (youtube.ts) and executeScript (service-worker.ts)
  // --------------------------------------------------------------------------
  LINKS: {
    /** Channel pages: multiple renderer types depending on sub-page layout */
    CHANNEL: [
      'ytd-rich-item-renderer a#video-title-link',
      'ytd-grid-video-renderer a#video-title',
      'ytd-video-renderer a#video-title',
      'ytd-compact-video-renderer a.yt-simple-endpoint',
    ].join(', '),

    /** Playlist page: single renderer type */
    PLAYLIST: 'ytd-playlist-video-renderer a#video-title',

    /** Search results: single renderer type */
    SEARCH: 'ytd-video-renderer a#video-title',
  },

  // --------------------------------------------------------------------------
  // Ad / Promoted video filtering
  // --------------------------------------------------------------------------
  AD: {
    /** Parent renderer elements that wrap individual video cards */
    RENDERERS: [
      'ytd-video-renderer',
      'ytd-rich-item-renderer',
      'ytd-grid-video-renderer',
      'ytd-compact-video-renderer',
    ].join(', '),

    /** Search promoted video slot — ancestor indicates ad placement */
    PROMOTED_SLOT: 'ytd-search-pyv-renderer',

    /** Badge elements that may contain "Sponsored" / "Ad" / "廣告" text */
    BADGES: 'ytd-badge-supported-renderer, [class*="badge"], [class*="promoted"]',

    /**
     * Regex source for matching ad/sponsored text.
     * Stored as string (not RegExp) for JSON serializability.
     * Usage: `new RegExp(YT.AD.PATTERN, 'i').test(text)`
     */
    PATTERN: '廣告|Sponsored|Ad\\b',
  },

  // --------------------------------------------------------------------------
  // Title & name extraction — fallback chains
  // --------------------------------------------------------------------------
  TITLE: {
    /** Current video title on watch page */
    VIDEO: [
      'h1.ytd-watch-metadata yt-formatted-string',
      '#title h1 yt-formatted-string',
      'h1.title',
    ],

    /** Channel name — used in content script */
    CHANNEL: [
      'ytd-channel-name yt-formatted-string#text',
      '#channel-name yt-formatted-string',
      'yt-page-header-renderer yt-dynamic-text-view-model span',
      '#channel-header #channel-name',
    ],

    /** Page title extraction in executeScript (playlist header) */
    PLAYLIST_HEADER: 'yt-formatted-string.ytd-playlist-header-renderer, h1 yt-formatted-string',

    /** Page title extraction in executeScript (channel name) */
    CHANNEL_HEADER: 'ytd-channel-name yt-formatted-string, #channel-name yt-formatted-string',
  },

  // --------------------------------------------------------------------------
  // Player
  // --------------------------------------------------------------------------
  PLAYER: '#movie_player',

  // --------------------------------------------------------------------------
  // Transcript — Tier 2 DOM scraping (executeScript MAIN world)
  // --------------------------------------------------------------------------
  TRANSCRIPT: {
    /** Expanded transcript panel — used to detect/close stale panels */
    PANEL_EXPANDED: [
      'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
    ],

    /** Close button inside transcript panel header */
    PANEL_CLOSE: [
      'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"] #header button',
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #header button',
    ],

    /** Buttons that open transcript (in description or dedicated section) */
    OPEN_BUTTONS: '#description button, ytd-video-description-transcript-section-renderer button',

    /** Description expand/collapse toggles */
    DESCRIPTION_EXPAND: '#expand',
    DESCRIPTION_COLLAPSE: '#collapse',

    /** Modern transcript segment container (2024+) */
    SEGMENT_MODERN: 'transcript-segment-view-model',
    SEGMENT_MODERN_TIMESTAMP: '.ytwTranscriptSegmentViewModelTimestamp',
    SEGMENT_MODERN_TEXT: 'span.yt-core-attributed-string',

    /** Legacy transcript segment container */
    SEGMENT_LEGACY: 'ytd-transcript-segment-renderer',
    SEGMENT_LEGACY_TIMESTAMP: '.segment-timestamp',
    SEGMENT_LEGACY_TEXT: '.segment-text',

    /** Known transcript button labels across locales */
    BUTTON_LABELS: [
      '轉錄稿', '转录稿', '字幕記錄', '字幕记录',
      'transcript', 'Transcript', '文字起こし',
    ],
  },
} as const;

// ============================================================================
// NotebookLM Selectors
// ============================================================================

export const NLM = {
  /**
   * Source card anchor — future unification point for NLM DOM queries.
   * NLM's DOM changes frequently; this serves as a stable base selector
   * that other queries can be built upon.
   */
  SOURCE_CARD: '[class*="source"]',

  /** Elements containing source count text (e.g. "35 sources", "35 個來源") */
  SOURCE_HEADERS: '[class*="source"]',

  /** Actual source link elements in sidebar */
  SOURCE_ITEMS: 'a[href*="youtube.com/watch"], a[href*="youtu.be"], [class*="source-item"], [class*="source-container"]',

  /** All YouTube links visible on the NLM page */
  YOUTUBE_LINKS: 'a[href*="youtube.com/watch"], a[href*="youtu.be"]',

  /** Warning/limit/error banner elements */
  WARNINGS: '[class*="limit"], [class*="warning"], [class*="error"]',

  // --------------------------------------------------------------------------
  // AI Response Area — for reading generated content & button injection
  //
  // Verified against live NLM DOM (2026-04-06). Structure:
  //   div.chat-message-pair > chat-message > div.to-user-container >
  //     mat-card.to-user-message-card-content >
  //       mat-card-content.message-content   ← response text here
  //       mat-card-actions.message-actions   ← toolbar (copy/thumbs) here
  //         chat-actions.actions-container >
  //           div.action > div > span.mat-mdc-tooltip-trigger > button
  //
  // User questions use: mat-card.from-user-message-card-content
  // AI responses use:   mat-card.to-user-message-card-content
  // --------------------------------------------------------------------------

  /** AI response card — the mat-card wrapping an AI reply (NOT user questions) */
  RESPONSE_CARD: [
    'mat-card.to-user-message-card-content',
    'mat-card[class*="to-user"]',
  ],

  /** AI response text container inside the card */
  RESPONSE_TEXT: [
    'mat-card-content.message-content',
    'mat-card-content[class*="message-content"]',
  ],

  /** Toolbar container holding copy/thumbs buttons */
  RESPONSE_TOOLBAR: [
    'mat-card-actions.message-actions',
    'mat-card-actions[class*="message-actions"]',
  ],

  /**
   * The actual Copy button for model responses.
   * aria-label varies by locale but always contains locale-specific "copy" word.
   * The button has class `xap-copy-to-clipboard` which is also stable.
   */
  RESPONSE_COPY_BTN: [
    'button.xap-copy-to-clipboard',                   // stable class on the copy button itself
    'button[aria-label*="模型回覆"]',                   // zh-TW: "將模型回覆複製到剪貼簿"
    'button[aria-label*="model response" i]',          // EN
    'button[aria-label*="モデルの回答"]',                 // ja
    'button[aria-label*="复制到剪贴板"]',                 // zh-CN
  ],

  /** Loading / streaming indicator — present while AI is still generating */
  RESPONSE_LOADING: [
    'mat-progress-bar',
    'mat-spinner',
    '[role="progressbar"]',
    '[aria-busy="true"]',
  ],
} as const;
