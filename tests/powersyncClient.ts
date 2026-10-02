/**
 * A minimal reader for the PowerSync sync-stream protocol, for the integration
 * suite only. It opens the same HTTP stream the client SDK opens, with a token
 * geneus-server minted, and collects the rows in the first complete checkpoint.
 * That is exactly what a freshly enrolled device receives — so asserting on it
 * is asserting on facility isolation as PowerSync actually enforces it.
 *
 * The protocol is PowerSync's own (newline-delimited JSON: `checkpoint`, one
 * `data` line per bucket, `checkpoint_complete`); the SDK is not used here
 * because it needs a browser or a native SQLite, and because reading the raw
 * stream leaves nothing between the assertion and the service.
 */
export type SyncedRow = { table: string; id: string; data: Record<string, unknown> };

export type CheckpointResult = { status: number; rows: SyncedRow[]; buckets: string[] };

type DataLine = {
  data?: { bucket: string; data: { op: string; object_type: string; object_id: string; data: string | null }[] };
  checkpoint?: { buckets: { bucket: string }[] };
  checkpoint_complete?: unknown;
};

export const readFirstCheckpoint = async (
  endpoint: string,
  token: string,
  timeoutMs = 20_000,
): Promise<CheckpointResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint}/sync/stream`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        buckets: [],
        include_checksum: true,
        raw_data: true,
        client_id: `test-${Math.random().toString(36).slice(2)}`,
        streams: { include_defaults: true, subscriptions: [] },
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return { status: response.status, rows: [], buckets: [] };

    const rows: SyncedRow[] = [];
    const buckets: string[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const parsed = JSON.parse(line) as DataLine;
        if (parsed.checkpoint) buckets.push(...parsed.checkpoint.buckets.map((bucket) => bucket.bucket));
        for (const entry of parsed.data?.data ?? []) {
          if (entry.op === 'PUT' && entry.data) {
            rows.push({ table: entry.object_type, id: entry.object_id, data: JSON.parse(entry.data) as Record<string, unknown> });
          }
        }
        if (parsed.checkpoint_complete !== undefined) {
          await reader.cancel().catch(() => undefined);
          return { status: response.status, rows, buckets };
        }
      }
    }
    return { status: response.status, rows, buckets };
  } finally {
    clearTimeout(timer);
  }
};

/** Polls the stream until `predicate` sees the row it wants, or gives up. */
export const waitForRow = async (
  endpoint: string,
  token: string,
  predicate: (row: SyncedRow) => boolean,
  attempts = 10,
): Promise<{ found: SyncedRow | undefined; last: CheckpointResult }> => {
  let last: CheckpointResult = { status: 0, rows: [], buckets: [] };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await readFirstCheckpoint(endpoint, token);
    const found = last.rows.find(predicate);
    if (found) return { found, last };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { found: undefined, last };
};
