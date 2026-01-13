# Performance

This document describes how Pickme stays fast today and the improvements we plan to deliver next. The focus is on real-world latency: the time between typing `@` and seeing suggestions.

## Current performance characteristics

- Each `@` query invokes `file-suggestion.sh`.
- The script runs `pickme search`, which opens SQLite, performs the query, and exits.
- Cold start and process startup often dominate the latency budget.

## Planned improvements (no Bun rewrite)

### 1) Auto-start daemon + idle shutdown

Goal: eliminate per-query process startup.

Plan:

- Run a long-lived Pickme daemon with a pre-opened SQLite connection.
- The hook should try the daemon first. If not running, it starts the daemon and retries.
- Shut down after a configurable idle period (e.g. 6 hours).

Details:

- New command: `pickme serve`.
- New config options: `daemon.enabled`, `daemon.idle_hours`, `daemon.socket_path`.
- Hook path:
  1. connect to socket
  2. fallback to start daemon
  3. retry once

### 2) Prefix reuse cache (per @ session)

Goal: avoid repeated DB queries during typing.

Plan:

- Cache results for the previous prefix and filter/rerank in memory for the next prefix.
- Treat consecutive queries as a single typing session while the daemon is alive.

Details:

- Only cache when the new query extends the previous query.
- Short TTL and bounded cache size to keep memory low.

### 3) Short TTL cache with file-change invalidation

Goal: instant responses for repeated queries without staleness.

Plan:

- Cache results by `(cwd, namespace, query)` for 2-5 seconds.
- Invalidate cache entries immediately on file changes.

Details:

- Use a file watcher (per root) in the daemon.
- Maintain LRU with max entries.

### 4) SQLite read tuning

Goal: reduce per-query latency at the DB layer.

Plan:

- Apply read-optimized pragmas:
  - `journal_mode=WAL`
  - `synchronous=NORMAL`
  - `temp_store=MEMORY`
  - tuned `cache_size` and `mmap_size`

Details:

- Applied during DB initialization in the daemon and CLI paths.

### 5) Precomputed namespace membership

Goal: make `@namespace:` lookups constant-time.

Plan:

- Maintain `file_namespaces(path, namespace)` during indexing.
- Use this table to filter namespace searches.

Details:

- No post-filtering by glob during query time.

### 6) In-memory filename set for fuzzy fallback

Goal: fast fuzzy results when there are no exact matches.

Plan:

- Maintain an in-memory list of filenames and relative paths.
- Bound by root/namespace for memory control.

Details:

- Use only for fuzzy fallback or explicit `@~` queries.
- Invalidate and rebuild on file changes.

### 7) Minimal query path in the hook

Goal: reduce overhead for the fallback path (when daemon is unavailable).

Plan:

- Add a minimal `pickme query` subcommand that only performs a search and prints results.

Details:

- No extra formatting or config output.

### 8) Disk cache fallback (no daemon)

Goal: reuse recent results even with short-lived processes.

Plan:

- Write cached results to `~/.local/share/pickme/cache/` keyed by `(cwd, namespace, query)`.
- Use a short TTL to avoid stale results.

### 9) Early cutoff for incomplete queries

Goal: reduce work while the user is still typing.

Plan:

- Use a lower result limit for very short queries.
- Increase limits as the query length grows.

### 10) Debounce (intentionally skipped for now)

We are not adding debouncing until we observe evidence that Claude triggers redundant calls per keystroke. Debug logging will inform this.

## Measuring impact

- Use `PICKME_DEBUG=1` with a session ID to record timings.
- Compare:
  - baseline (short-lived process)
  - daemon with caching
  - daemon + watcher invalidation

## Notes on memory

Every in-memory optimization is bounded (TTL or LRU) to keep memory stable. Defaults should be safe for typical dev machines and can be tuned via config.
