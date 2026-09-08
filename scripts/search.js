// Query the knowledge base from the shell.
//
//   node scripts/search.js "rag retrieval"
//   node scripts/search.js "how do I stop an agent grading its own work"
//   node scripts/search.js "claude" --category ai-and-automation --actionable
//   node scripts/search.js --gaps            # records with content still missing
//   node scripts/search.js "premortem" --full
//
// Hybrid by default (keyword + semantic, rank-fused) once embeddings exist;
// keyword-only before that, and it says which mode it used. Every hit prints
// its id and url so anything quoted can be traced to the post it came from.
process.emitWarning = ((orig) => (w, ...r) =>
  String(w).includes('SQLite is an experimental') ? undefined : orig.call(process, w, ...r)
)(process.emitWarning);

const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { retrieve, excerpt } = require('./lib-retrieve.js');

const argv = process.argv.slice(2);
const flags = {}; const terms = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    if (['actionable', 'full', 'gaps', 'keyword'].includes(k)) flags[k] = true;
    else flags[k] = argv[++i];
  } else terms.push(argv[i]);
}
const query = terms.join(' ').trim();
const ROOT = path.join(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'kb.sqlite'));

(async () => {
  // No search term (e.g. `--gaps` alone): list records instead of searching.
  if (!query) {
    let sql = `SELECT id, url, creator, category, topics, media, completeness,
                      shared, path, title FROM records WHERE 1=1`;
    const p = [];
    if (flags.category) { sql += ' AND category = ?'; p.push(flags.category); }
    if (flags.creator) { sql += ' AND creator = ?'; p.push(flags.creator); }
    if (flags.actionable) sql += ' AND actionable = 1';
    if (flags.gaps) sql += " AND completeness NOT IN ('full','no-speech','')";
    sql += ' ORDER BY shared DESC LIMIT ?';
    p.push(Number(flags.limit || 10));
    return show(db.prepare(sql).all(...p), null);
  }

  const { rows, mode, reason } = await retrieve(db, query, {
    limit: Number(flags.limit || 10),
    category: flags.category,
    actionable: flags.actionable,
    gaps: flags.gaps
  });
  show(rows, mode, reason);
})().catch(e => { console.error('error:', e.message); process.exit(1); });

function show(rows, mode, reason) {
  if (!rows.length) { console.log('no matches'); return; }
  for (const r of rows) {
    const gap = r.completeness && !['full', 'no-speech'].includes(r.completeness)
      ? `  [${r.completeness}]` : '';
    console.log(`\n${r.id}${gap}${r.matched ? `  (${r.matched})` : ''}`);
    console.log(`  ${r.title}`);
    console.log(`  ${r.creator} · ${r.category} · ${r.media} · shared ${r.shared}`);
    if (r.topics) console.log(`  topics: ${r.topics}`);
    console.log(`  ${r.url}`);
    if (query) console.log(`  ${excerpt(r, query)}`);
    if (flags.full) console.log('\n' + fs.readFileSync(path.join(ROOT, r.path), 'utf8'));
  }
  const tail = mode ? `${rows.length} result(s), ${mode} search.` : `${rows.length} result(s).`;
  console.log(`\n${tail}${reason ? ` (${reason})` : ''}`);
}
