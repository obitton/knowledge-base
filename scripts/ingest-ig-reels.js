// Source adapter: ig-reels-corpus -> knowledge-base/sources/ig-reels/
//
// One markdown record per post, with a metadata header the indexer reads.
// Adapters are the only place that knows about a source's shape; everything
// downstream (index, search, MCP) works on these records alone. Adding a
// second source means adding a second adapter, not changing the store.
const fs = require('fs'), path = require('path');

const CORPUS = process.argv[2] || 'C:/dev/ig-reels-corpus';
const OUT = path.join(__dirname, '..', 'sources', 'ig-reels');
fs.mkdirSync(OUT, { recursive: true });

const readJson = p => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
const readText = p => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';

const doc = readJson(path.join(CORPUS, 'data/thread_v3.json'));
if (!doc) throw new Error('no data/thread_v3.json in ' + CORPUS);

const yaml = v => Array.isArray(v)
  ? '[' + v.map(x => JSON.stringify(String(x))).join(', ') + ']'
  : typeof v === 'string' ? JSON.stringify(v) : String(v);

const seen = new Set();
let written = 0; const gaps = [];

for (const m of doc.messages) {
  if (!m.media || seen.has(m.media.code)) continue;
  seen.add(m.media.code);
  const md = m.media;

  const t = readJson(path.join(CORPUS, `data/transcripts/${md.code}.json`));
  const tags = readJson(path.join(CORPUS, `data/tags/${md.code}.json`));
  const vision = readText(path.join(CORPUS, `data/vision/${md.code}.md`));
  const slideInfo = (doc.carousels || {})[md.code];
  const slideCount = slideInfo && slideInfo.slides ? slideInfo.slides.length : 0;

  const transcript = t && !t.error && !t.no_speech ? t.text : '';

  // Be explicit about what is missing rather than letting a thin record look
  // complete. Anything not "full" is a known gap, listed at the end of a run.
  let completeness = 'full';
  if (md.is_video && !transcript) {
    completeness = t && t.no_speech ? 'no-speech' : 'transcript-missing';
  }
  if (slideCount > 0 && !vision) completeness = 'slides-unread';
  if (!md.is_video && slideCount === 0 && !vision) completeness = 'caption-only';
  if (completeness !== 'full' && completeness !== 'no-speech') {
    gaps.push(`${md.code}  ${completeness.padEnd(19)} @${md.owner}${slideCount ? `  (${slideCount} slides)` : ''}`);
  }

  const comments = (doc.comments || {})[md.pk];
  const topComments = Array.isArray(comments)
    ? comments.filter(c => c.likes > 5).slice(0, 8) : [];

  const head = [
    '---',
    `id: ${yaml('ig-reels/' + md.code)}`,
    `source: ${yaml('instagram')}`,
    `url: ${yaml(md.permalink)}`,
    `creator: ${yaml('@' + (md.owner || 'unknown'))}`,
    `creator_name: ${yaml(md.owner_name || '')}`,
    `posted: ${yaml((md.posted_at || '').slice(0, 10))}`,
    `shared: ${yaml(m.sent_at.slice(0, 10))}`,
    `media: ${yaml(slideCount > 1 ? `carousel(${slideCount})` : md.is_video ? 'video' : 'image')}`,
    `duration_s: ${md.duration ? Math.round(md.duration) : 0}`,
    `category: ${yaml((tags && tags.category) || 'unlabelled')}`,
    `topics: ${yaml((tags && tags.topics) || [])}`,
    `content_type: ${yaml((tags && tags.content_type) || '')}`,
    `actionable: ${tags ? !!tags.actionable : false}`,
    `completeness: ${yaml(completeness)}`,
    '---', ''
  ];

  const body = [`# ${md.owner_name || '@' + md.owner} — ${md.code}`, ''];
  if (md.caption) body.push('## Caption', '', md.caption.trim(), '');
  if (transcript) body.push('## Transcript', '', transcript, '');
  if (vision) body.push('## On-screen content', '', vision, '');
  if (slideCount > 0 && !vision) {
    body.push('## On-screen content', '',
      `_${slideCount} slide${slideCount > 1 ? 's' : ''} downloaded but not yet read. ` +
      `Images: ${CORPUS}/media/images/${md.code}_NN.jpg_`, '');
  }
  if (topComments.length) {
    body.push('## Top comments', '');
    for (const c of topComments) {
      body.push(`- **@${c.user}**${c.by_author ? ' (creator)' : ''} (${c.likes} likes): ${String(c.text).replace(/\s+/g, ' ').trim()}`);
    }
    body.push('');
  }

  fs.writeFileSync(path.join(OUT, `${md.code}.md`), head.concat(body).join('\n'));
  written++;
}

console.log(`ingested ${written} records into sources/ig-reels/`);
if (gaps.length) {
  console.log(`\n${gaps.length} incomplete records:`);
  gaps.sort().forEach(g => console.log('  ' + g));
}
