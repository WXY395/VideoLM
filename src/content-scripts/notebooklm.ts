/**
 * Content script injected into NotebookLM pages.
 * Handles source creation and duplicate detection.
 */

// TODO: Task 3 — implement NLM interaction logic
// This script will:
// 1. Listen for IMPORT_TO_NLM messages from the service worker
// 2. Interact with the NLM UI to paste content as a new source
// 3. Check for duplicate sources before importing

console.log('VideoLM: NotebookLM content script loaded');
