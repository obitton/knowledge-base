# knowledge-base

A local, citable store of saved ideas — engineering tips, AI/agent techniques,
career and business notes — with full-text search and an MCP server so Claude
and Codex both read the same thing.

Zero dependencies. Node's built-in `node:sqlite` provides FTS5; the markdown
records are the source of truth and the database is a derived artifact.

## Use it

```bash
node scripts/search.js "rag retrieval"
node scripts/search.js "how do I stop an agent grading its own work"
node scripts/search.js "claude code" --category ai-and-automation --actionable
node scripts/search.js --gaps               # records with content still missing
node scripts/search.js "premortem" --full   # print the whole record
```

From an agent, via the `knowledge-base` MCP server: `kb_search`, `kb_get`,
`kb_stats`. Every result carries its record id and source url.

## Always available, nothing running

An stdio MCP server is not a daemon. Claude Code and Codex each spawn
`node scripts/mcp-server.js` when a session starts and stop it on exit. There is
nothing to keep alive, nothing to restart after a reboot, and no port in use.

**Claude Code** — registered at user scope, so it is available in every project:

```bash
claude mcp add knowledge-base --scope user -- node C:/dev/knowledge-base/scripts/mcp-server.js
claude mcp list      # should report: knowledge-base ... Connected
```

**Codex** — configured in `~/.codex/config.toml`:

```toml
[mcp_servers.knowledge-base]
command = "node"
args = ["C:/dev/knowledge-base/scripts/mcp-server.js"]
```

**Claude skills** — `~/.claude/skills/knowledge-base/` tells agents when to
consult the base and how to cite it, so it gets used without being asked for
by name.

## Rebuild

```bash
node scripts/ingest-ig-reels.js   # source -> sources/ig-reels/*.md
node scripts/build-index.js       # sources/ + notes/ -> kb.sqlite
```

`ingest` prints every record it could not fully populate, so gaps stay visible
instead of quietly looking complete.

## Layout

```
sources/<adapter>/<id>.md   captured items: metadata header + caption/transcript/slides/comments
notes/<slug>.md             notes you write, citing source ids
kb.sqlite                   FTS5 index (derived, safe to delete)
scripts/                    ingest / build-index / search / mcp-server
```

### Record metadata

`id · source · url · creator · posted · shared · media · duration_s ·
category · topics · content_type · actionable · completeness`

`completeness` is the honesty field:

| value | meaning |
|---|---|
| `full` | everything available was captured |
| `no-speech` | a video with no speech (music only); caption carries the content |
| `slides-unread` | carousel images downloaded but not yet read |
| `transcript-missing` | transcription failed |
| `caption-only` | nothing but the caption |

## Adding another source

Write an adapter in `scripts/` that writes records into `sources/<name>/` using
the same metadata header, then rebuild. The index, search and MCP server only
know about records, so nothing downstream changes.

## Retrieval: hybrid, with a keyword floor

Two rankers, fused with **Reciprocal Rank Fusion**:

- **BM25** over the FTS5 index — catches exact codes, ids and rare proper nouns
  (`knip`, `madge`, a reel shortcode) that embeddings reliably miss
- **Dense vectors** — `all-MiniLM-L6-v2` running locally via ONNX, so a plain
  question finds the right record without sharing its vocabulary

RRF ranks by position in each list rather than by score, so two incomparable
scales never need calibrating against each other.

This is the "Hybrid RAG" pattern the corpus itself argues is the current
production baseline — see `ig-reels/DZXRaPokeCR`, which calls it "the new
baseline, not an upgrade."

**Embeddings are optional.** Without them, everything degrades to the keyword
search it started as, and search says which mode it used. Nothing breaks:

```bash
npm install @huggingface/transformers   # one-time, ~100MB
node scripts/embed.js                   # downloads the ~25MB model once, then offline
node scripts/embed.js --all             # re-embed everything
```

`embed.js` is incremental: it hashes each record and re-embeds only what
changed. Long records are chunked (1200 chars, 200 overlap) so a 12-slide
carousel covering several ideas isn't averaged into one mushy vector.

No API key, no data leaving the machine. That matters — the point of a local
knowledge base is that it stays local.

### Why not a vector database

There isn't one, and at this size there shouldn't be. Cosine similarity over a
few hundred normalised vectors is a linear scan that finishes instantly; an ANN
index would add a dependency and a build step to solve a problem the corpus does
not have. Revisit at a scale where a linear scan actually hurts.

This is the same reasoning as a client appraisal-KB proposal I wrote, which put a
vector DB on the explicitly rejected list for a curated corpus — with the
correction that *semantic* retrieval was worth having; a separate vector
*database* still isn't.

## What is and isn't in this repo

The retrieval engine, the ingest adapter, the MCP server, and the notes are
here. The corpus is not: `sources/` is other people's posts, transcribed and
slide-read for personal study, and it stays on the machine that built it.
Clone this, point an adapter at your own saved content, rebuild, and you have
the same thing over your material.

## Current contents

One source: `ig-reels` — 223 records distilled from an Instagram DM thread
(2025-04-25 → 2026-09-07). 189 video transcripts via Whisper, 284 carousel and
image slides read visually, plus captions and top comments for every post.
Built by the pipeline in `C:\dev\ig-reels-corpus`.

Coverage is complete: 215 records `full`, 8 `no-speech` (music-only videos whose
caption carries the content), nothing missing. By category, the corpus is mostly
AI/automation (72) and software engineering (28), then business and marketing
(59).
