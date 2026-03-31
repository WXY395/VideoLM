import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome storage mock
// ---------------------------------------------------------------------------
const storageData: Record<string, unknown> = {};

const chromeMock = {
  storage: {
    local: {
      get: vi.fn((keys: string | string[]) => {
        const result: Record<string, unknown> = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          if (k in storageData) result[k] = storageData[k];
        }
        return Promise.resolve(result);
      }),
      set: vi.fn((items: Record<string, unknown>) => {
        Object.assign(storageData, items);
        return Promise.resolve();
      }),
      remove: vi.fn((keys: string | string[]) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) delete storageData[k];
        return Promise.resolve();
      }),
    },
  },
};

// Assign before importing the module under test
(globalThis as any).chrome = chromeMock;

const {
  createBatchQueue,
  saveQueue,
  loadQueue,
  clearQueue,
  hasPendingQueue,
  advanceQueue,
  QUEUE_KEY,
  MAX_BATCH_SIZE,
} = await import('../batch-queue');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearStorage() {
  for (const key of Object.keys(storageData)) delete storageData[key];
}

function makeUrls(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `https://youtube.com/watch?v=vid${i}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('batch-queue', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  // ---- createBatchQueue ---------------------------------------------------

  describe('createBatchQueue', () => {
    it('creates 1 chunk for 25 URLs', () => {
      const urls = makeUrls(25);
      const queue = createBatchQueue(urls, 'My Playlist');

      expect(queue.chunks).toHaveLength(1);
      expect(queue.chunks[0]).toHaveLength(25);
      expect(queue.currentChunk).toBe(0);
      expect(queue.pageTitle).toBe('My Playlist');
      expect(queue.totalUrls).toBe(25);
      expect(queue.createdAt).toBeGreaterThan(0);
    });

    it('creates 3 chunks for 120 URLs (50+50+20)', () => {
      const urls = makeUrls(120);
      const queue = createBatchQueue(urls, 'Big Playlist');

      expect(queue.chunks).toHaveLength(3);
      expect(queue.chunks[0]).toHaveLength(50);
      expect(queue.chunks[1]).toHaveLength(50);
      expect(queue.chunks[2]).toHaveLength(20);
      expect(queue.totalUrls).toBe(120);
    });

    it('creates 1 chunk for exactly 50 URLs', () => {
      const urls = makeUrls(50);
      const queue = createBatchQueue(urls, 'Exact Fit');

      expect(queue.chunks).toHaveLength(1);
      expect(queue.chunks[0]).toHaveLength(50);
    });

    it('creates 2 chunks for 51 URLs (50+1)', () => {
      const urls = makeUrls(51);
      const queue = createBatchQueue(urls, 'Just Over');

      expect(queue.chunks).toHaveLength(2);
      expect(queue.chunks[0]).toHaveLength(50);
      expect(queue.chunks[1]).toHaveLength(1);
    });
  });

  // ---- persistence --------------------------------------------------------

  describe('saveQueue / loadQueue', () => {
    it('round-trips through storage', async () => {
      const queue = createBatchQueue(makeUrls(75), 'Stored');
      await saveQueue(queue);

      const loaded = await loadQueue();
      expect(loaded).toEqual(queue);
    });

    it('returns null when no queue exists', async () => {
      const loaded = await loadQueue();
      expect(loaded).toBeNull();
    });
  });

  // ---- clearQueue ---------------------------------------------------------

  describe('clearQueue', () => {
    it('removes the queue from storage', async () => {
      const queue = createBatchQueue(makeUrls(10), 'Temp');
      await saveQueue(queue);
      expect(await hasPendingQueue()).toBe(true);

      await clearQueue();
      expect(await hasPendingQueue()).toBe(false);
      expect(await loadQueue()).toBeNull();
    });
  });

  // ---- hasPendingQueue ----------------------------------------------------

  describe('hasPendingQueue', () => {
    it('returns false when storage is empty', async () => {
      expect(await hasPendingQueue()).toBe(false);
    });

    it('returns true when a queue is saved', async () => {
      await saveQueue(createBatchQueue(makeUrls(5), 'Test'));
      expect(await hasPendingQueue()).toBe(true);
    });
  });

  // ---- advanceQueue -------------------------------------------------------

  describe('advanceQueue', () => {
    it('increments currentChunk and persists', async () => {
      const queue = createBatchQueue(makeUrls(120), 'Advance');
      await saveQueue(queue);

      const updated = await advanceQueue();
      expect(updated).not.toBeNull();
      expect(updated!.currentChunk).toBe(1);

      // Verify it was persisted
      const fromStorage = await loadQueue();
      expect(fromStorage!.currentChunk).toBe(1);
    });

    it('returns null and clears storage when all chunks are done', async () => {
      // 2 chunks: index 0 and 1
      const queue = createBatchQueue(makeUrls(60), 'Small');
      queue.currentChunk = 1; // Already on the last chunk
      await saveQueue(queue);

      const result = await advanceQueue();
      expect(result).toBeNull();
      expect(await hasPendingQueue()).toBe(false);
    });

    it('returns null when no queue exists', async () => {
      const result = await advanceQueue();
      expect(result).toBeNull();
    });

    it('walks through all chunks sequentially', async () => {
      const queue = createBatchQueue(makeUrls(120), 'Walk');
      await saveQueue(queue);

      // Chunk 0 -> 1
      const q1 = await advanceQueue();
      expect(q1!.currentChunk).toBe(1);

      // Chunk 1 -> 2
      const q2 = await advanceQueue();
      expect(q2!.currentChunk).toBe(2);

      // Chunk 2 -> done (3 chunks total, index 2 is last)
      const q3 = await advanceQueue();
      expect(q3).toBeNull();
    });
  });
});
