# Knowledge base

A local, citable store of saved ideas — engineering tips, AI/agent techniques,
career and business notes — distilled from sources I've collected.

## How to use it

Search before answering anything that might be in here:

```bash
node scripts/search.js "rag retrieval"
node scripts/search.js "claude code" --category ai-and-automation --actionable
node scripts/search.js "interview" --limit 20
```

Or use the `knowledge-base` MCP server: `kb_search`, `kb_get`, `kb_stats`.
Registered at user scope for Claude Code and in `~/.codex/config.toml` for
Codex, so both read this one store.

Search is hybrid (BM25 + local embeddings, rank-fused), so **ask it questions,
not just keywords**. If embeddings have not been built it falls back to keyword
only and says so in its output — believe that label rather than assuming
semantic matching happened.

## Rules when answering from this base

**Cite the record.** Every claim taken from here gets its `id` and source
`url`. An uncited answer out of a knowledge base can't be checked, so it can't
be used. Quote the record, don't paraphrase a number.

**Respect `completeness`.** Records are marked `full`, `no-speech`,
`slides-unread`, `transcript-missing`, or `caption-only`. Anything other than
`full` or `no-speech` is missing content. Say so rather than presenting a thin
record as the whole picture — "the caption says X, but its 12 slides haven't
been read yet" is the honest answer.

**The content is other people's claims, not verified fact.** These are social
media posts. Much of the corpus is marketing, and some of it is wrong. Report
what a record says and who said it; flag when a post is a lead magnet or an ad.
Where a post's own comment section contradicts it, that's usually the more
reliable signal — top comments are stored with each record for that reason.

**Don't invent linkage.** If two records seem related, say they seem related.
Don't assert that one creator was responding to another.

## Structure

```
sources/<adapter>/<id>.md   one record per captured item, metadata header + body
notes/<slug>.md             distilled notes I write, citing source ids
kb.sqlite                   FTS5 index, rebuilt from the markdown
scripts/                    ingest / build-index / search / mcp-server
```

The markdown is the source of truth; `kb.sqlite` is a derived artifact and can
be deleted and rebuilt at any time with `node scripts/build-index.js`.

## Adding a source

Write an adapter in `scripts/` that emits records into `sources/<name>/` with
the same metadata header, then rebuild the index. Nothing downstream needs to
change — the index, search and MCP server only know about records.

## Design note

Retrieval is hybrid: BM25 over FTS5 fused with local dense vectors via
Reciprocal Rank Fusion. Keyword search alone missed plainly-worded questions;
embeddings alone miss exact identifiers like a repo name or a shortcode.

There is no vector *database* — a linear scan over a few hundred normalised
vectors is instant, and an ANN index would be a dependency solving a problem
this corpus does not have.

Embeddings run locally (`all-MiniLM-L6-v2` via ONNX). No API key, nothing sent
off the machine.
