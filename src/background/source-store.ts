import type { VideoSourceRecord } from '@/types';

const STORAGE_KEY = '_videolm_source_index';
const MAX_RECORDS = 500;

export async function loadSourceIndex(): Promise<VideoSourceRecord[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] as VideoSourceRecord[]) ?? [];
}

export async function saveSourceIndex(records: VideoSourceRecord[]): Promise<void> {
  const sorted = [...records].sort((a, b) => b.addedAt - a.addedAt);
  const trimmed = sorted.slice(0, MAX_RECORDS);
  await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
}

export async function upsertSourceRecord(record: VideoSourceRecord): Promise<void> {
  const index = await loadSourceIndex();
  const existingIdx = index.findIndex(r => r.videoId === record.videoId);
  if (existingIdx >= 0) {
    const existing = index[existingIdx];
    record.sessions = [...new Set([...existing.sessions, ...record.sessions])];
    record.addedAt = Math.max(existing.addedAt, record.addedAt);
    index[existingIdx] = record;
  } else {
    index.push(record);
  }
  await saveSourceIndex(index);
}

export async function appendSession(videoId: string, sessionId: string): Promise<void> {
  const index = await loadSourceIndex();
  const record = index.find(r => r.videoId === videoId);
  if (record && !record.sessions.includes(sessionId)) {
    record.sessions.push(sessionId);
    await saveSourceIndex(index);
  }
}
