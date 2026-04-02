// ---------------------------------------------------------------------------
// NLM API — List notebooks via wXbhsf RPC (batchexecute)
// ---------------------------------------------------------------------------

export interface NlmNotebook {
  id: string;
  name: string;
  sourceCount: number;
  emoji: string;
  /** YouTube video IDs already in this notebook (extracted from source data) */
  sourceVideoIds: string[];
}

// ---------------------------------------------------------------------------
// Session token helpers
// ---------------------------------------------------------------------------

async function fetchSessionTokens(authuser = ''): Promise<{ bl: string; atToken: string } | null> {
  const authuserParam = authuser ? `?authuser=${authuser}&pageId=none` : '';
  try {
    const resp = await fetch(
      `https://notebooklm.google.com/${authuserParam}`,
      { redirect: 'error' },
    );
    if (!resp.ok) return null;

    const html = await resp.text();
    const bl = html.match(/"cfb2h":"([^"]+)"/)?.[1] || '';
    const atToken = html.match(/"SNlM0e":"([^"]+)"/)?.[1] || '';
    if (!bl || !atToken) return null;

    return { bl, atToken };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Notebook cache (30 s TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;

let cachedNotebooks: NlmNotebook[] | null = null;
let cacheTimestamp = 0;

export function clearNotebookCache(): void {
  cachedNotebooks = null;
  cacheTimestamp = 0;
}

// ---------------------------------------------------------------------------
// listNlmNotebooks — wXbhsf RPC via batchexecute
// ---------------------------------------------------------------------------

export async function listNlmNotebooks(authuser = ''): Promise<NlmNotebook[]> {
  // Return cached result if still fresh
  if (cachedNotebooks && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedNotebooks;
  }

  const tokens = await fetchSessionTokens(authuser);
  if (!tokens) {
    console.log('[VideoLM] listNlmNotebooks: failed to get session tokens');
    return [];
  }

  const { bl, atToken } = tokens;

  const rpcId = 'wXbhsf';
  const innerPayload = JSON.stringify([null, 1, null, [2]]);
  const fReq = JSON.stringify([[[rpcId, innerPayload, null, 'generic']]]);
  const reqId = Math.floor(100000 + Math.random() * 900000);

  const qp = new URLSearchParams({
    'rpcids': rpcId,
    'source-path': '/',
    'bl': bl,
    '_reqid': String(reqId),
    'rt': 'c',
  });
  if (authuser) qp.append('authuser', authuser);

  const body = new URLSearchParams({ 'f.req': fReq, 'at': atToken });

  try {
    const resp = await fetch(
      `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${qp.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
    );

    if (!resp.ok) {
      console.log(`[VideoLM] listNlmNotebooks: HTTP ${resp.status}`);
      return [];
    }

    const text = await resp.text();

    // Parse batchexecute response — find the data line containing wrb.fr
    // Response format: ")]}'"\n\n123\n[["wrb.fr",...]]
    // Competitor uses split("\n")[3]; we also try trimmed line matching as fallback
    const lines = text.split('\n');
    let dataLine = '';

    // Method 1: Competitor approach — line index 3
    if (lines.length > 3) {
      const candidate = lines[3].trim();
      if (candidate.startsWith('[')) {
        dataLine = candidate;
      }
    }

    // Method 2: Scan for wrb.fr line (fallback)
    if (!dataLine) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[["wrb.fr"') || trimmed.startsWith('[[["wrb.fr"')) {
          dataLine = trimmed;
          break;
        }
      }
    }

    if (!dataLine) {
      console.log('[VideoLM] listNlmNotebooks: no data line found. Lines:', lines.length, 'First 200 chars:', text.substring(0, 200));
      return [];
    }

    const outer = JSON.parse(dataLine) as unknown[][];
    const innerRaw = (outer[0] as unknown[])[2] as string;
    const inner = JSON.parse(innerRaw) as unknown[][];

    if (!inner || !Array.isArray(inner[0])) {
      console.log('[VideoLM] listNlmNotebooks: unexpected inner structure');
      return [];
    }

    const notebooks: NlmNotebook[] = [];

    for (const t of inner[0] as unknown[][]) {
      // Filter out archived notebooks: t[5] is array and t[5][0] === 3
      if (Array.isArray(t[5]) && (t[5] as unknown[])[0] === 3) {
        continue;
      }

      // Extract YouTube video IDs from source items in t[1]
      // Known structure: src[2][5] = ["https://www.youtube.com/watch?v=ID", "ID", "ChannelName"]
      const sourceVideoIds: string[] = [];
      if (Array.isArray(t[1])) {
        for (const src of t[1] as unknown[]) {
          if (!Array.isArray(src)) continue;
          try {
            // Primary: src[2][5][1] is the video ID directly
            const meta = (src as any)[2];
            if (Array.isArray(meta)) {
              const ytData = meta[5];
              if (Array.isArray(ytData) && typeof ytData[1] === 'string' && ytData[1].length === 11) {
                sourceVideoIds.push(ytData[1]);
                continue;
              }
              // Fallback: extract from URL at ytData[0]
              if (Array.isArray(ytData) && typeof ytData[0] === 'string') {
                const m = ytData[0].match(/[?&]v=([\w-]{11})/);
                if (m) { sourceVideoIds.push(m[1]); continue; }
              }
            }
            // Deep fallback: scan entire source item for YouTube URLs
            const json = JSON.stringify(src);
            const m = json.match(/watch\?v=([\w-]{11})/);
            if (m) sourceVideoIds.push(m[1]);
          } catch { /* skip malformed source */ }
        }
      }

      notebooks.push({
        name: (t[0] as string) || '',
        sourceCount: Array.isArray(t[1]) ? (t[1] as unknown[]).length : 0,
        id: (t[2] as string) || '',
        emoji: (t[3] as string) || '',
        sourceVideoIds,
      });
    }

    // Update cache
    cachedNotebooks = notebooks;
    cacheTimestamp = Date.now();

    console.log(`[VideoLM] listNlmNotebooks: found ${notebooks.length} notebooks`);
    return notebooks;
  } catch (e) {
    console.log('[VideoLM] listNlmNotebooks error:', e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// findMatchingNotebooks — fuzzy name matching
// ---------------------------------------------------------------------------

/** Strip " - Part N" suffix and normalize for comparison */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s*-\s*part\s+\d+$/i, '');
}

/**
 * Find notebooks whose normalized name matches the given page title.
 * Matches if either name startsWith the other (handles truncation).
 */
export function findMatchingNotebooks(
  notebooks: NlmNotebook[],
  pageTitle: string,
): NlmNotebook[] {
  const normalizedTitle = normalizeName(pageTitle);
  if (!normalizedTitle) return [];

  const MIN_MATCH_LENGTH = 5; // Prevent false matches on short names like "AI"

  return notebooks
    .filter((nb) => {
      const normalizedNb = normalizeName(nb.name);
      if (!normalizedNb || normalizedNb.length < MIN_MATCH_LENGTH) return false;
      if (normalizedTitle.length < MIN_MATCH_LENGTH) return false;
      return normalizedNb.startsWith(normalizedTitle) || normalizedTitle.startsWith(normalizedNb);
    })
    // Prefer the notebook with most sources (main notebook before Part N)
    .sort((a, b) => b.sourceCount - a.sourceCount);
}
