// Hybrid retrieval: BM25 keyword search fused with dense-vector search using
// Reciprocal Rank Fusion.
//
// This is the "Hybrid RAG" pattern the corpus itself recommends as the current
// production baseline (see record ig-reels/DZXRaPokeCR): dense vectors catch
// meaning, BM25 catches the things embeddings reliably miss — exact codes, IDs,
// rare proper nouns like `knip` or `madge` — and rank fusion avoids having to
// calibrate two incomparable score scales against each other.
//
// Degrades cleanly: with no vectors table, it is exactly the keyword search it
// was before, and says so.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

const K = 60;   // RRF damping constant; standard value from the original paper

function hasVectors(db) {
  const t = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vectors'").get();
  if (!t) return false;
  return db.prepare('SELECT COUNT(*) c FROM vectors').get().c > 0;
}

// FTS5 treats bare hyphens, quotes and operators as syntax. Callers pass human
// text, so fall back to a sanitised OR-query rather than erroring out.
function ftsRank(db, query, limit) {
  const attempt = q => db.prepare(
    `SELECT r.id, rank FROM fts JOIN records r ON r.id = fts.id
     WHERE fts MATCH ? ORDER BY rank LIMIT ?`).all(q, limit);
  try {
    return attempt(query);
  } catch {
    const safe = query.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/)
      .filter(Boolean).map(w => `"${w}"`).join(' OR ');
    if (!safe) return [];
    try { return attempt(safe); } catch { return []; }
  }
}

async function vectorRank(db, query, limit) {
  let pipeline;
  try { ({ pipeline } = await import('@huggingface/transformers')); }
  catch { return null; }

  const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const out = await embed(query.replace(/\s+/g, ' ').trim(), { pooling: 'mean', normalize: true });
  const q = Float32Array.from(out.data);

  // A few hundred records is far too small to justify an ANN index; a linear
  // scan over normalised vectors is a dot product per chunk and is instant.
  const best = new Map();
  for (const row of db.prepare('SELECT id, vec FROM vectors').all()) {
    const v = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
    let dot = 0;
    for (let i = 0; i < q.length; i++) dot += q[i] * v[i];
    // best-matching chunk represents the record
    if (!best.has(row.id) || dot > best.get(row.id)) best.set(row.id, dot);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));
}

/**
 * @returns {{rows: object[], mode: 'hybrid'|'keyword', reason?: string}}
 */
async function retrieve(db, query, { limit = 10, category, actionable, gaps } = {}) {
  const pool = Math.max(limit * 5, 50);

  const keyword = ftsRank(db, query, pool);
  let vector = null, reason;
  if (!hasVectors(db)) {
    reason = 'no embeddings yet — run `node scripts/embed.js` to enable semantic search';
  } else {
    vector = await vectorRank(db, query, pool);
    if (!vector) reason = '@huggingface/transformers not installed — keyword only';
  }

  // Reciprocal Rank Fusion: score by position in each list, not by raw score,
  // so BM25 and cosine never need to be normalised against each other.
  const fused = new Map();
  const add = (list, tag) => list.forEach(({ id }, i) => {
    const e = fused.get(id) || { id, score: 0, from: [] };
    e.score += 1 / (K + i + 1);
    e.from.push(tag);
    fused.set(id, e);
  });
  add(keyword, 'keyword');
  if (vector) add(vector, 'semantic');

  const ranked = [...fused.values()].sort((a, b) => b.score - a.score);

  const byId = new Map(db.prepare(
    `SELECT id, url, creator, category, topics, media, completeness, shared, path, title
     FROM records`).all().map(r => [r.id, r]));

  const out = [];
  for (const hit of ranked) {
    const rec = byId.get(hit.id);
    if (!rec) continue;
    if (category && rec.category !== category) continue;
    if (actionable && !db.prepare('SELECT actionable a FROM records WHERE id=?').get(hit.id).a) continue;
    if (gaps && ['full', 'no-speech', ''].includes(rec.completeness)) continue;
    out.push({ ...rec, matched: hit.from.join('+') });
    if (out.length >= limit) break;
  }

  return { rows: out, mode: vector ? 'hybrid' : 'keyword', reason };
}

// Short excerpt around the best keyword hit, for display.
function excerpt(rec, query, len = 240) {
  const body = fs.readFileSync(path.join(ROOT, rec.path), 'utf8').replace(/\s+/g, ' ');
  const word = (query.match(/\p{L}{4,}/gu) || [])[0];
  const at = word ? body.toLowerCase().indexOf(word.toLowerCase()) : -1;
  const start = at > 80 ? at - 80 : 0;
  return (start ? '… ' : '') + body.slice(start, start + len).trim() + '…';
}

module.exports = { retrieve, excerpt, hasVectors };
