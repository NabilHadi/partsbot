import type { Db } from "../db/pool.js";

/** Claims a key exactly once. Backed by Postgres (inbound_dedupe) so it survives restarts and retries over ~51h. */
export interface DedupeStore {
  /** true if this call claimed the key, false if it was already claimed. */
  claim(key: string, eventId: string): Promise<boolean>;
  /** Undo a claim (used when enqueueing failed, so Zernio's retry is processed). */
  release(key: string): Promise<void>;
}

export function createPgDedupeStore(db: Db): DedupeStore {
  return {
    async claim(key, eventId) {
      const res = await db.query(
        "INSERT INTO inbound_dedupe (dedupe_key, event_id) VALUES ($1, $2) ON CONFLICT (dedupe_key) DO NOTHING",
        [key, eventId],
      );
      return (res.rowCount ?? 0) === 1;
    },
    async release(key) {
      await db.query("DELETE FROM inbound_dedupe WHERE dedupe_key = $1", [key]);
    },
  };
}
