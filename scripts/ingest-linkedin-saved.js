#!/usr/bin/env node
// LinkedIn saved posts -> sources/linkedin-saved/<id>.md
//
// Input: a text file of post URLs, one per line (# comments allowed). Collect
// them by hand from linkedin.com/my-items/saved-posts/; this script never
// touches a logged-in session. Each URL is fetched once, unauthenticated, with
// a pause between requests. LinkedIn serves the post body to logged-out
// visitors; comments and reaction counts sit behind the sign-in wall and are
// not captured, so this adapter has no "top comments" reliability signal.
//
//   node scripts/ingest-linkedin-saved.js [urls.txt]   (default C:/dev/linkedin-saved-urls.txt)
//
// Node built-ins only. Rebuild the index afterwards: node scripts/build-index.js

const fs = require('fs'), path = require('path');

const LIST = process.argv[2] || 'C:/dev/linkedin-saved-urls.txt';
const OUT = path.join(__dirname, '..', 'sources', 'linkedin-saved');
const PAUSE_MS = 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

fs.mkdirSync(OUT, { recursive: true });

const yaml = v => Array.isArray(v)
  ? `[${v.map(x => JSON.stringify(String(x))).join(', ')}]`
  : JSON.stringify(v == null ? '' : String(v));

const unescapeHtml = s => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

const stripTags = s => unescapeHtml(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').trim();

function idFor(url) {
  const m = url.match(/activity[:-](\d{15,})/);
  if (m) return `activity-${m[1]}`;
  const slug = url.match(/\/posts\/([^/?#]+)/);
  return slug ? slug[1].slice(0, 80) : Buffer.from(url).toString('base64url').slice(0, 24);
}

function extract(html) {
  const meta = (p) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${p}"[^>]+content="([^"]*)"`, 'i'))
           || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${p}"`, 'i'));
    return m ? unescapeHtml(m[1]) : '';
  };
  const ogTitle = meta('og:title'), ogDesc = meta('og:description'), ogImage = meta('og:image');

  // Post body: the attributed-text paragraph carries the full post; og:description is
  // the fallback and may be truncated for long posts.
  const blocks = [...html.matchAll(/<p[^>]*attributed-text[^>]*>([\s\S]*?)<\/p>/g)].map(m => stripTags(m[1])).filter(Boolean);
  let text = blocks[0] || '';
  let completeness = 'full';
  if (!text) { text = ogDesc.split(' | ')[0].trim(); completeness = text ? 'caption-only' : 'transcript-missing'; }

  // Author: logged-out pages put it at the tail of og:description as
  // "...post | <Author> | N comments". The JSON-LD "author" entries are the
  // commenters, not the poster, so they are deliberately not used.
  const segs = ogDesc.split(' | ').map(t => t.trim());
  let author = 'unknown';
  if (segs.length >= 2) {
    const last = segs[segs.length - 1];
    const isCount = t => /^\d+\s+comments?(\s+on\s+LinkedIn)?$/i.test(t);
    author = isCount(last) && segs.length >= 3 ? segs[segs.length - 2] : last;
  }
  if (!author || /^\d+\s+comments?(\s+on\s+LinkedIn)?$/i.test(author)) author = (ogTitle.match(/^(.*?) on LinkedIn:/) || [])[1] || 'unknown';
  const authorUrl = (html.match(/https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9_-]+/) || [])[0] || '';

  // Date: JSON-LD when present, otherwise the relative "1mo" marker is all LinkedIn gives logged-out
  const posted = (html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/) || [])[1] || '';

  // Media: a document/carousel viewer or an article link means content this adapter did not read
  const isDoc = /document-viewer|\.pdf|native-document|ssplayer/i.test(html);
  // External link the post points at, ignoring LinkedIn's own hosts and its CDN
  const article = ([...html.matchAll(/https?:\/\/([a-z0-9.-]+)[^"'<>\s]*/gi)]
    .filter(m => !/(^|\.)(linkedin\.com|licdn\.com|lnkd\.in)$/i.test(m[1]))
    .map(m => m[0])[0]) || '';
  let media = ogImage ? 'image' : 'text';
  if (isDoc) { media = 'document'; if (completeness === 'full') completeness = 'slides-unread'; }

  return { text, author, authorUrl, posted, ogImage, article, media, completeness };
}

async function fetchOnce(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow' });
  const html = await r.text();
  return { status: r.status, html };
}

(async () => {
  if (!fs.existsSync(LIST)) { console.error(`No URL list at ${LIST}`); process.exit(1); }
  const urls = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const today = new Date().toISOString().slice(0, 10);
  const gaps = [];
  let written = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i], id = idFor(url), file = path.join(OUT, `${id}.md`);
    if (fs.existsSync(file)) { console.log(`skip  ${id} (exists)`); continue; }
    let res;
    try { res = await fetchOnce(url); if (res.status !== 200 || res.html.length < 5000) { await new Promise(r => setTimeout(r, PAUSE_MS)); res = await fetchOnce(url); } }
    catch (e) { gaps.push(`${id}  fetch-failed  ${e.message}`); continue; }
    if (res.status !== 200) { gaps.push(`${id}  http-${res.status}`); continue; }

    const x = extract(res.html);
    if (x.completeness !== 'full') gaps.push(`${id}  ${x.completeness.padEnd(19)} ${x.author}`);

    const head = [
      '---',
      `id: ${yaml('linkedin-saved/' + id)}`,
      `source: ${yaml('linkedin')}`,
      `url: ${yaml(url)}`,
      `creator: ${yaml(x.authorUrl || x.author)}`,
      `creator_name: ${yaml(x.author)}`,
      `posted: ${yaml(x.posted)}`,
      `shared: ${yaml(today)}`,
      `media: ${yaml(x.media)}`,
      `category: ${yaml('unlabelled')}`,
      `topics: ${yaml([])}`,
      `content_type: ${yaml('')}`,
      `actionable: false`,
      `completeness: ${yaml(x.completeness)}`,
      '---',
      '',
      `# ${x.author} — ${id}`,
      '',
      '## Post',
      x.text || '(no text captured)',
      '',
    ];
    if (x.article) head.push('## Linked', x.article, '');
    if (x.ogImage) head.push('## Image', x.ogImage, '');
    head.push('## Comments', 'Not captured: LinkedIn shows comments and reactions only to signed-in visitors, and this adapter fetches logged out.', '');
    fs.writeFileSync(file, head.join('\n'));
    written++;
    console.log(`wrote ${id}  ${x.completeness}  ${x.author}`);
    if (i < urls.length - 1) await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  console.log(`\n${written} written, ${gaps.length} with gaps`);
  if (gaps.length) { console.log('\nGaps (content this adapter could not fully capture):'); gaps.forEach(g => console.log('  ' + g)); }
})();
