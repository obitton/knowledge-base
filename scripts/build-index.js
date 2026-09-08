// Builds kb.sqlite: an FTS5 index over every record in sources/ and notes/.
//
// Deliberately not a vector store. For a curated corpus of this size, keyword
// search over structured records answers the questions asked of it, stays
// debuggable, and returns a citable id for every hit. Revisit if the corpus
// grows past the point where recall actually suffers.
// node:sqlite is stable enough for this use; its experimental warning is noise.
const _emit = process.emitWarning;
process.emitWarning = (w, ...r) => {
  if (String(w).includes('SQLite is an experimental')) return;
  _emit.call(process, w, ...r);
};
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'kb.sqlite');

function parse(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    try { v = JSON.parse(v); } catch { /* bare scalar: keep as text */ }
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.md') ? [p] : []);
  });
}

// Don't delete the file: the MCP server holds it open, so rmSync fails with
// EPERM whenever that server is connected. Drop and recreate the tables inside
// the existing database instead.
const db = new DatabaseSync(DB);
db.exec(`
  DROP TABLE IF EXISTS records;
  DROP TABLE IF EXISTS fts;
  CREATE TABLE records (
    id TEXT PRIMARY KEY, kind TEXT, url TEXT, creator TEXT,
    posted TEXT, shared TEXT, media TEXT, category TEXT,
    topics TEXT, content_type TEXT, actionable INTEGER,
    completeness TEXT, path TEXT, title TEXT
  );
  CREATE VIRTUAL TABLE fts USING fts5(
    id UNINDEXED, title, topics, body,
    tokenize = 'porter unicode61'
  );
`);

const insRec = db.prepare(`INSERT OR REPLACE INTO records
  (id,kind,url,creator,posted,shared,media,category,topics,content_type,actionable,completeness,path,title)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insFts = db.prepare('INSERT INTO fts (id,title,topics,body) VALUES (?,?,?,?)');

let n = 0;
for (const kind of ['sources', 'notes']) {
  for (const file of walk(path.join(ROOT, kind))) {
    const { meta, body } = parse(file);
    const id = meta.id || path.relative(ROOT, file).replace(/\\/g, '/').replace(/\.md$/, '');
    const title = (body.match(/^#\s+(.+)$/m) || [, id])[1];
    const topics = Array.isArray(meta.topics) ? meta.topics.join(' ') : String(meta.topics || '');
    insRec.run(id, kind, meta.url || '', meta.creator || '', meta.posted || '',
      meta.shared || '', meta.media || '', meta.category || '', topics,
      meta.content_type || '', meta.actionable ? 1 : 0, meta.completeness || '',
      path.relative(ROOT, file).replace(/\\/g, '/'), title);
    insFts.run(id, title, topics, body);
    n++;
  }
}

const stats = db.prepare(`SELECT completeness, COUNT(*) c FROM records GROUP BY completeness ORDER BY c DESC`).all();
const cats = db.prepare(`SELECT category, COUNT(*) c FROM records GROUP BY category ORDER BY c DESC LIMIT 8`).all();
db.close();

console.log(`indexed ${n} records -> kb.sqlite`);
console.log('completeness:', stats.map(r => `${r.completeness || 'note'}=${r.c}`).join('  '));
console.log('categories:  ', cats.map(r => `${r.category || '-'}=${r.c}`).join('  '));
