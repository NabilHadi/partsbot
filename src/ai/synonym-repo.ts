/** Postgres access for the synonym list and the AI's pending suggestions (migration 006). */
import type { Db } from "../db/pool.js";
import { SynonymIndex, synonymKey, type SuggestionInput, type SynonymEntry } from "./synonyms.js";

export interface SynonymRow {
  id: string;
  term: string;
  term_key: string;
  canonical_ar: string;
  canonical_en: string;
  status: "active" | "disabled";
  needs_review: boolean;
  source: "seed" | "admin" | "suggestion";
  updated_at: Date;
}

export interface SuggestionRow {
  id: string;
  term: string;
  term_key: string;
  canonical_ar: string;
  canonical_en: string;
  status: "pending" | "approved" | "rejected";
  seen_count: number;
  first_seen: Date;
  last_seen: Date;
}

export async function loadActiveSynonyms(db: Db): Promise<SynonymEntry[]> {
  const r = await db.query<{ term: string; canonical_ar: string; canonical_en: string }>(
    "SELECT term, canonical_ar, canonical_en FROM synonyms WHERE status = 'active' ORDER BY id",
  );
  return r.rows.map((x) => ({ term: x.term, canonicalAr: x.canonical_ar, canonicalEn: x.canonical_en }));
}

/** Cached index for the worker (the list changes rarely; admin edits show up within `ttlMs`). */
export function cachedSynonymIndex(db: Db, ttlMs = 60_000, now: () => number = Date.now): () => Promise<SynonymIndex> {
  let cache: { at: number; index: SynonymIndex } | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.index;
    const index = new SynonymIndex(await loadActiveSynonyms(db));
    cache = { at: now(), index };
    return index;
  };
}

/** Upsert a pending suggestion (seen_count++). Ignored when the term is already in the list or was decided. */
export async function recordSuggestion(db: Db, s: SuggestionInput): Promise<void> {
  const key = synonymKey(s.term);
  if (!key || !s.canonicalAr.trim()) return;
  await db.query(
    `INSERT INTO synonym_suggestions (term, term_key, canonical_ar, canonical_en)
     SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM synonyms WHERE term_key = $2)
     ON CONFLICT (term_key, canonical_ar) DO UPDATE SET
       seen_count = synonym_suggestions.seen_count + 1, last_seen = now()
     WHERE synonym_suggestions.status = 'pending'`,
    [s.term.slice(0, 80), key, s.canonicalAr.slice(0, 80), s.canonicalEn.slice(0, 80)],
  );
}

export async function listSynonyms(db: Db): Promise<SynonymRow[]> {
  return (await db.query<SynonymRow>("SELECT * FROM synonyms ORDER BY needs_review DESC, canonical_en, term")).rows;
}

export async function listSuggestions(db: Db, status: "pending" | "all" = "pending"): Promise<SuggestionRow[]> {
  return (
    await db.query<SuggestionRow>(
      `SELECT * FROM synonym_suggestions ${status === "pending" ? "WHERE status = 'pending'" : ""} ORDER BY seen_count DESC, last_seen DESC LIMIT 200`,
    )
  ).rows;
}

export class SynonymInputError extends Error {}

export interface SynonymInput {
  term: string;
  canonicalAr: string;
  canonicalEn: string;
  status?: "active" | "disabled";
  needsReview?: boolean;
}

function check(i: SynonymInput): { term: string; key: string; ar: string; en: string } {
  const term = i.term.trim();
  const ar = i.canonicalAr.trim();
  const en = i.canonicalEn.trim();
  const key = synonymKey(term);
  if (!key) throw new SynonymInputError("The customer word is required.");
  if (!ar) throw new SynonymInputError("The canonical Arabic name is required.");
  if (term.length > 80 || ar.length > 80 || en.length > 80) throw new SynonymInputError("Keep each field under 80 characters.");
  return { term, key, ar, en };
}

async function keyTaken(db: Db, key: string, exceptId: string | null): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM synonyms WHERE term_key = $1 AND ($2::bigint IS NULL OR id <> $2::bigint)", [key, exceptId]);
  return (r.rowCount ?? 0) > 0;
}

export async function addSynonym(db: Db, i: SynonymInput, source: "admin" | "suggestion" = "admin"): Promise<string> {
  const c = check(i);
  if (await keyTaken(db, c.key, null)) throw new SynonymInputError(`"${c.term}" is already in the list (same spelling after normalization).`);
  const r = await db.query<{ id: string }>(
    "INSERT INTO synonyms (term, term_key, canonical_ar, canonical_en, status, needs_review, source) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [c.term, c.key, c.ar, c.en, i.status ?? "active", i.needsReview ?? false, source],
  );
  return r.rows[0]!.id;
}

export async function updateSynonym(db: Db, id: string, i: SynonymInput): Promise<SynonymRow | null> {
  const c = check(i);
  if (await keyTaken(db, c.key, id)) throw new SynonymInputError(`"${c.term}" is already in the list (same spelling after normalization).`);
  const r = await db.query<SynonymRow>(
    `UPDATE synonyms SET term=$2, term_key=$3, canonical_ar=$4, canonical_en=$5, status=$6, needs_review=$7, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [id, c.term, c.key, c.ar, c.en, i.status ?? "active", i.needsReview ?? false],
  );
  return r.rows[0] ?? null;
}

export async function deleteSynonym(db: Db, id: string): Promise<SynonymRow | null> {
  return (await db.query<SynonymRow>("DELETE FROM synonyms WHERE id = $1 RETURNING *", [id])).rows[0] ?? null;
}

/** Approve: copy into the list (optionally with edited names), mark approved. Returns the new synonym id. */
export async function approveSuggestion(db: Db, id: string, edit?: Partial<SynonymInput>): Promise<{ suggestion: SuggestionRow; synonymId: string } | null> {
  const s = (await db.query<SuggestionRow>("SELECT * FROM synonym_suggestions WHERE id = $1 AND status = 'pending'", [id])).rows[0];
  if (!s) return null;
  const synonymId = await addSynonym(
    db,
    { term: edit?.term ?? s.term, canonicalAr: edit?.canonicalAr || s.canonical_ar, canonicalEn: edit?.canonicalEn ?? s.canonical_en },
    "suggestion",
  );
  await db.query("UPDATE synonym_suggestions SET status = 'approved', decided_at = now() WHERE id = $1", [id]);
  return { suggestion: s, synonymId };
}

export async function rejectSuggestion(db: Db, id: string): Promise<SuggestionRow | null> {
  return (
    await db.query<SuggestionRow>("UPDATE synonym_suggestions SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *", [id])
  ).rows[0] ?? null;
}
