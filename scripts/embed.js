// Computes local sentence embeddings for every record and stores them in
// kb.sqlite, enabling semantic search alongside the FTS5 keyword index.
//
// Runs entirely offline after the first run: all-MiniLM-L6-v2 (~25MB ONNX) is
// downloaded once and cached under node_modules/.cache. No API key, no data
// leaving the machine — which matters, because the point of a local knowledge
// base is that it stays local.
//
//   node scripts/embed.js          # embed anything new or changed
//   node scripts/embed.js --all    # re-embed everything
process.emitWarning = ((orig) => (w, ...r) =>
  String(w).includes('SQLite is an experimental') ? undefined : orig.call(process, w, ...r)
)(process.emitWarning);

const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
const CHUNK = 1200;      // characters per chunk
const OVERLAP = 200;     // carried between chunks so ideas aren't split mid-sentence
const REDO = process.argv.includes('--all');

// Long records are chunked: a 12-slide carousel covers several distinct ideas,
// and embedding it as one vector averages them into mush.
function chunk(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= CHUNK) return [clean];
  const out = [];
  for (let i = 0; i < clean.length; i += CHUNK - OVERLAP) {
    out.push(clean.slice(i, i + CHUNK));
    if (i + CHUNK >= clean.length) break;
  }
  return out;
}

(async () => {
  let pipeline;
  try {
    ({ pipeline } = await import('@huggingface/transformers'));
  } catch {
    console.error('Embeddings need @huggingface/transformers:');
    console.error('  cd C:/dev/knowledge-base && npm install @huggingface/transformers');
    console.error('Search still works without it — it just falls back to keyword-only.');
    process.exit(1);
  }

  const db = new DatabaseSync(path.join(ROOT, 'kb.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS vectors (
    id TEXT, chunk INTEGER, hash TEXT, vec BLOB,
    PRIMARY KEY (id, chunk)
  )`);

  const rows = db.prepare('SELECT id, path FROM records').all();
  const have = new Map(
    db.prepare('SELECT id, hash FROM vectors WHERE chunk = 0').all().map(r => [r.id, r.hash])
  );

  const todo = [];
  for (const r of rows) {
    const body = fs.readFileSync(path.join(ROOT, r.path), 'utf8');
    const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
    if (!REDO && have.get(r.id) === hash) continue;   // unchanged since last run
    todo.push({ ...r, body, hash });
  }

  if (!todo.length) {
    console.log(`all ${rows.length} records already embedded and unchanged`);
    db.close();
    return;
  }

  console.log(`embedding ${todo.length} of ${rows.length} records (model loads on first run)…`);
  const embed = await pipeline('feature-extraction', MODEL);

  const del = db.prepare('DELETE FROM vectors WHERE id = ?');
  const ins = db.prepare('INSERT INTO vectors (id, chunk, hash, vec) VALUES (?,?,?,?)');

  let done = 0, chunks = 0;
  for (const r of todo) {
    del.run(r.id);
    const parts = chunk(r.body);
    for (let i = 0; i < parts.length; i++) {
      // mean-pooled + normalised => cosine similarity is a plain dot product
      const out = await embed(parts[i], { pooling: 'mean', normalize: true });
      const vec = Float32Array.from(out.data);
      if (vec.length !== DIM) throw new Error(`expected ${DIM} dims, got ${vec.length}`);
      ins.run(r.id, i, r.hash, Buffer.from(vec.buffer));
      chunks++;
    }
    if (++done % 25 === 0) console.log(`  ${done}/${todo.length}`);
  }

  console.log(`embedded ${done} records into ${chunks} chunks`);
  db.close();
})();
