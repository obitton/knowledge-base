#!/usr/bin/env node
// LinkedIn saved posts -> sources/linkedin-saved/<id>.md
//
// Input: a text file of post URLs, one per line (# comments allowed). Collect
// them by hand from linkedin.com/my-items/saved-posts/; this script never
// touches a logged-in session. Each URL is fetched once, unauthenticated, with
// a pause between requests. LinkedIn serves logged-out visitors a JSON-LD
// SocialMediaPosting block with the full post, the author, the date, the
// visible comments, and reaction counts, so records carry the same
// top-comments reliability signal the reels adapter has.
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
  const ogTitle = meta('og:title'), ogDesc = meta('og:description'), ogImage = meta('og:image'), ogUrl = meta('og:url');

  // Primary source: the page's JSON-LD block. Logged-out pages serve either a
  // SocialMediaPosting (articleBody, author.name, comment[].author.name) or,
  // for video posts, a VideoObject (description, creator.name,
  // comment[].creator.name, optional transcript). Verified 2026-09-08 against
  // live posts of both kinds; everything below is fallback for pages that
  // omit the block.
  let ld = null;
  for (const m of html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)) {
    try {
      const d = JSON.parse(unescapeHtml(m[1]));
      if (d && (d['@type'] === 'SocialMediaPosting' || d['@type'] === 'VideoObject')) { ld = d; break; }
    } catch {}
  }
  const isVideo = !!(ld && ld['@type'] === 'VideoObject');

  // Post body: JSON-LD articleBody (SocialMediaPosting) or description
  // (VideoObject; the caption field is short/empty, ignore it), then the
  // attributed-text paragraph, then og:description with its trailing
  // " | N comments on LinkedIn" removed.
  let text = ld && (ld.articleBody || ld.description) ? String(ld.articleBody || ld.description).trim() : '';
  let completeness = 'full';
  if (!text) {
    const blocks = [...html.matchAll(/<p[^>]*attributed-text[^>]*>([\s\S]*?)<\/p>/g)].map(m => stripTags(m[1])).filter(Boolean);
    text = blocks[0] || '';
  }
  if (!text) { text = ogDesc.replace(/\s*\|\s*\d+\s+comments?(\s+on\s+LinkedIn)?\s*$/i, '').trim(); completeness = text ? 'caption-only' : 'transcript-missing'; }

  // Author: JSON-LD author.name (SocialMediaPosting) or creator.name
  // (VideoObject). Fallback is the tail of og:title, which reads
  // "<truncated post> | <Author> | N comments". Description tags carry no author.
  let author = ld && ld.author && ld.author.name ? String(ld.author.name).trim()
    : ld && ld.creator && ld.creator.name ? String(ld.creator.name).trim()
    : '';
  if (!author) author = (ogTitle.match(/\s\|\s([^|]+?)\s\|\s\d+\s+comments?\s*$/) || ogTitle.match(/\s\|\s([^|]+?)\s*$/) || [])[1] || 'unknown';

  // Author URL: prefer JSON-LD creator.url / author.url when it points at a
  // LinkedIn profile or company page, else fall back to the og:url shape
  // /posts/<author-slug>_<post-slug>-activity-<id>-<hash>.
  const ldAuthorUrl = (ld && ld.creator && ld.creator.url) || (ld && ld.author && ld.author.url) || '';
  let authorUrl = /linkedin\.com\/(in|company)\//i.test(ldAuthorUrl) ? ldAuthorUrl : '';
  if (!authorUrl) {
    const slug = (ogUrl.match(/\/posts\/([A-Za-z0-9-]+?)_/) || [])[1] || '';
    authorUrl = slug ? `https://www.linkedin.com/in/${slug}` : '';
  }

  const posted = ld && ld.datePublished ? String(ld.datePublished).slice(0, 10) : '';

  // Comments: JSON-LD carries the visible ones, under author.name
  // (SocialMediaPosting) or creator.name (VideoObject). Kept as the
  // reliability signal the reels adapter uses; a comment section that
  // contradicts a post is data.
  const comments = ld && Array.isArray(ld.comment)
    ? ld.comment.map(c => ({ who: (c.author && c.author.name) || (c.creator && c.creator.name) || 'unknown', text: String(c.text || '').trim() })).filter(c => c.text)
    : [];
  const commentCount = ld && ld.commentCount != null ? Number(ld.commentCount) : null;
  // interactionStatistic is an array on SocialMediaPosting, sometimes a bare
  // object on VideoObject; normalize to an array before hunting for LikeAction.
  const stats = ld && ld.interactionStatistic ? (Array.isArray(ld.interactionStatistic) ? ld.interactionStatistic : [ld.interactionStatistic]) : [];
  const reactions = (stats.find(x => /Like/i.test(String(x.interactionType || ''))) || {}).userInteractionCount ?? null;

  const transcript = isVideo && ld.transcript ? String(ld.transcript).trim() : '';

  // Media: a document/carousel viewer means slides this adapter did not read
  const isDoc = /document-viewer|native-document|ssplayer/i.test(html);
  // External link the post points at, ignoring LinkedIn's own hosts, its CDN, and boilerplate schema hosts
  const article = ([...html.matchAll(/https?:\/\/([a-z0-9.-]+)[^"'<>\s]*/gi)]
    .filter(m => !/(^|\.)(linkedin\.com|licdn\.com|lnkd\.in|schema\.org|w3\.org)$/i.test(m[1]))
    .map(m => m[0])[0]) || '';
  let media = ogImage ? 'image' : 'text';
  if (isDoc) { media = 'document'; if (completeness === 'full') completeness = 'slides-unread'; }
  if (isVideo) {
    media = 'video';
    // A video with only a caption/description and no transcript is incomplete,
    // same rule the reels adapter uses.
    if (!transcript) completeness = 'transcript-missing';
  }

  return { text, author, authorUrl, posted, ogImage, article, media, completeness, comments, commentCount, reactions, transcript };
}

async function fetchOnce(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow' });
  const html = await r.text();
  return { status: r.status, html, finalUrl: r.url };
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
    if (/\/signup\/|\/login|\/authwall|\/checkpoint\//.test(res.finalUrl || '')) { gaps.push(`${id}  login-wall`); continue; }

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
      `reactions: ${x.reactions == null ? '' : x.reactions}`,
      `comment_count: ${x.commentCount == null ? '' : x.commentCount}`,
      '---',
      '',
      `# ${x.author} — ${id}`,
      '',
      '## Post',
      x.text || '(no text captured)',
      '',
    ];
    if (x.media === 'video' && x.transcript) head.push('## Transcript', x.transcript, '');
    if (x.article) head.push('## Linked', x.article, '');
    if (x.ogImage) head.push('## Image', x.ogImage, '');
    if (x.comments.length) {
      head.push('## Comments' + (x.commentCount != null ? ` (${x.comments.length} of ${x.commentCount} shown)` : ''));
      for (const c of x.comments) head.push(`- **${c.who}:** ${c.text.replace(/\s*\n+\s*/g, ' ')}`);
      head.push('');
    } else {
      head.push('## Comments', 'None visible on the logged-out page.', '');
    }
    fs.writeFileSync(file, head.join('\n'));
    written++;
    console.log(`wrote ${id}  ${x.completeness}  ${x.author}`);
    if (i < urls.length - 1) await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  console.log(`\n${written} written, ${gaps.length} with gaps`);
  if (gaps.length) { console.log('\nGaps (content this adapter could not fully capture):'); gaps.forEach(g => console.log('  ' + g)); }
})();
