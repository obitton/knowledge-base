#!/usr/bin/env node
// Minimal stdio MCP server over kb.sqlite. No dependencies of its own: JSON-RPC
// 2.0 messages, one per line, on stdin/stdout.
//
// Register with Claude Code:
//   claude mcp add knowledge-base --scope user -- node C:/dev/knowledge-base/scripts/mcp-server.js
//
// Codex reads the same server from ~/.codex/config.toml. Nothing runs in the
// background — each agent spawns this process on session start and stops it on
// exit, so there is no daemon to keep alive or restart after a reboot.
//
// Every result carries its record id and source url so the caller can cite
// exactly where an answer came from. That is the point of the store: an
// uncited answer out of a knowledge base is one you cannot use.
process.emitWarning = ((orig) => (w, ...r) =>
  String(w).includes('SQLite is an experimental') ? undefined : orig.call(process, w, ...r)
)(process.emitWarning);

const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { retrieve, excerpt } = require('./lib-retrieve.js');

const ROOT = path.join(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'kb.sqlite'), { readOnly: true });

const TOOLS = [
  {
    name: 'kb_search',
    description: 'Search the personal knowledge base of saved ideas, engineering tips, ' +
      'prompts and AI/agent techniques. Hybrid keyword + semantic search, so plain ' +
      'questions work as well as keywords. Returns matching records with id, source ' +
      'url and an excerpt. Use the id with kb_get for the full text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A natural-language question or keywords.' },
        category: { type: 'string', description: 'Optional exact category filter, e.g. ai-and-automation' },
        actionable: { type: 'boolean', description: 'Only records containing a concrete applicable technique' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' }
      },
      required: ['query']
    }
  },
  {
    name: 'kb_get',
    description: 'Fetch one knowledge-base record in full by its id (e.g. ig-reels/DZXRaPokeCR).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'kb_stats',
    description: 'Describe what is in the knowledge base: record counts by category, ' +
      'source and completeness, and whether semantic search is available. Use this ' +
      'to know the limits of what it can answer.',
    inputSchema: { type: 'object', properties: {} }
  }
];

async function search({ query, category, actionable, limit }) {
  const q = String(query || '');
  const { rows, mode, reason } = await retrieve(db, q, {
    limit: Math.min(Number(limit) || 10, 50), category, actionable
  });
  if (!rows.length) {
    return 'No matches. Try broader terms, or kb_stats to see what the base covers.';
  }
  const blocks = rows.map(r => {
    const gap = r.completeness && !['full', 'no-speech'].includes(r.completeness)
      ? ' [INCOMPLETE: ' + r.completeness + ']' : '';
    return [
      '## ' + r.id + gap,
      r.title,
      r.creator + ' · ' + r.category + ' · ' + r.media + ' · shared ' + r.shared,
      'topics: ' + r.topics,
      'matched by: ' + r.matched,
      'source: ' + r.url,
      '',
      excerpt(r, q)
    ].join('\n');
  });
  const note = reason ? mode + ' search; ' + reason : mode + ' search';
  return blocks.join('\n\n---\n\n') + '\n\n(' + note + ')';
}

function get({ id }) {
  const row = db.prepare('SELECT path, url, completeness FROM records WHERE id = ?').get(id);
  if (!row) return 'No record with id "' + id + '".';
  const body = fs.readFileSync(path.join(ROOT, row.path), 'utf8');
  const warn = row.completeness && !['full', 'no-speech'].includes(row.completeness)
    ? '\n\n[NOTE: this record is incomplete (' + row.completeness +
      '). Do not present it as the full content.]'
    : '';
  return 'source: ' + row.url + '\n\n' + body + warn;
}

function stats() {
  const by = q => db.prepare(q).all().map(r => '  ' + (r.k || '(none)') + ': ' + r.c).join('\n');
  const total = db.prepare('SELECT COUNT(*) c FROM records').get().c;

  let semantic = 'keyword only (no embeddings built yet)';
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vectors'").get();
  if (t) {
    const n = db.prepare('SELECT COUNT(*) c FROM vectors').get().c;
    if (n) semantic = 'hybrid keyword + semantic (' + n + ' embedded chunks)';
  }

  return [
    total + ' records. Retrieval: ' + semantic + '.',
    '',
    'By category:',
    by('SELECT category k, COUNT(*) c FROM records GROUP BY category ORDER BY c DESC'),
    '',
    'By source kind:',
    by('SELECT kind k, COUNT(*) c FROM records GROUP BY kind'),
    '',
    'By completeness:',
    by('SELECT completeness k, COUNT(*) c FROM records GROUP BY completeness ORDER BY c DESC'),
    '',
    'Records marked other than "full" or "no-speech" are missing content (an unread',
    'carousel, a failed transcript). Treat their absence of detail as unknown, not as',
    'absence of substance.'
  ].join('\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'knowledge-base', version: '2.0.0' }
        });
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args = {} } = params || {};
        const fn = { kb_search: search, kb_get: get, kb_stats: stats }[name];
        if (!fn) return err(-32602, 'unknown tool: ' + name);
        return Promise.resolve()
          .then(() => fn(args))
          .then(text => ok({ content: [{ type: 'text', text }] }))
          .catch(e => err(-32603, e.message));
      }
      case 'ping':
        return ok({});
      default:
        return method && method.startsWith('notifications/')
          ? null
          : err(-32601, 'unknown method: ' + method);
    }
  } catch (e) {
    return err(-32603, e.message);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { continue; }
    // handle() may return a promise (tools/call), a plain value, or null.
    Promise.resolve(handle(msg)).then(res => {
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    });
  }
});
process.stdin.on('end', () => process.exit(0));
