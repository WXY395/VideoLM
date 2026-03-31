/**
 * Batch Queue Manager — splits large URL batches into chunks of ≤50,
 * persists the queue in chrome.storage.local for crash recovery,
 * and supports resumption after service worker restarts.
 */

export const QUEUE_KEY = 'videolm_batch_queue';
export const MAX_BATCH_SIZE = 50;

export interface BatchQueue {
  /** Array of URL chunks, each containing ≤ MAX_BATCH_SIZE URLs */
  chunks: string[][];
  /** Index of the chunk currently being processed (0-based) */
  currentChunk: number;
  /** Original playlist/channel name */
  pageTitle: string;
  /** Total number of URLs across all chunks */
  totalUrls: number;
  /** Timestamp when the queue was created */
  createdAt: number;
}

/** Save queue state to chrome.storage.local */
export async function saveQueue(queue: BatchQueue): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

/** Load queue from storage. Returns null if no queue exists. */
export async function loadQueue(): Promise<BatchQueue | null> {
  const result = await chrome.storage.local.get(QUEUE_KEY);
  return (result[QUEUE_KEY] as BatchQueue) ?? null;
}

/** Remove the queue from storage entirely. */
export async function clearQueue(): Promise<void> {
  await chrome.storage.local.remove(QUEUE_KEY);
}

/** Check whether an unfinished queue exists in storage. */
export async function hasPendingQueue(): Promise<boolean> {
  const queue = await loadQueue();
  return queue !== null;
}

/**
 * Create a new BatchQueue by splitting `urls` into chunks of MAX_BATCH_SIZE.
 * Does NOT persist — caller should follow up with `saveQueue()`.
 */
export function createBatchQueue(urls: string[], pageTitle: string): BatchQueue {
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += MAX_BATCH_SIZE) {
    chunks.push(urls.slice(i, i + MAX_BATCH_SIZE));
  }
  return {
    chunks,
    currentChunk: 0,
    pageTitle,
    totalUrls: urls.length,
    createdAt: Date.now(),
  };
}

/**
 * Mark the current chunk as done and advance to the next.
 * Persists the updated queue to storage.
 * Returns the updated queue, or null if all chunks have been processed.
 */
export async function advanceQueue(): Promise<BatchQueue | null> {
  const queue = await loadQueue();
  if (!queue) return null;

  queue.currentChunk += 1;

  if (queue.currentChunk >= queue.chunks.length) {
    // All chunks processed — clean up
    await clearQueue();
    return null;
  }

  await saveQueue(queue);
  return queue;
}
