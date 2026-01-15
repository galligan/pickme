/**
 * Database layer for the pickme file picker.
 *
 * Provides FTS5-indexed SQLite storage for file paths with frecency scoring.
 * Uses external content FTS5 for efficient updates and WAL mode for concurrent access.
 *
 * @module db
 */

import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { DatabaseError, FTSSyntaxError, matchesErrorPattern, ErrorPatterns } from './errors'
import { getDataDir } from './utils'

// Re-export types from shared types module for backwards compatibility
export type { FileMeta, FrecencyRecord, WatchedRoot, SearchResult, SearchOptions } from './types'

// Import types for local use
import type { FileMeta, FrecencyRecord, WatchedRoot, SearchResult, SearchOptions } from './types'

// ============================================================================
// Constants
// ============================================================================

/** Default database path (uses XDG Base Directory Specification) */
const DEFAULT_DB_PATH = join(getDataDir(), 'index.db')

/** Schema version for migrations */
const SCHEMA_VERSION = 1

// ============================================================================
// Schema SQL
// ============================================================================

/**
 * Individual SQL statements for schema initialization.
 * Split into separate statements since SQLite FTS5 virtual tables
 * require special handling.
 */
const SCHEMA_STATEMENTS = [
  // Schema version tracking
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Metadata table with primary key (source of truth)
  `CREATE TABLE IF NOT EXISTS files_meta (
    path TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    dir_components TEXT NOT NULL,
    root TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    relative_path TEXT
  )`,

  // Frecency scores for ranking
  `CREATE TABLE IF NOT EXISTS frecency (
    path TEXT PRIMARY KEY REFERENCES files_meta(path) ON DELETE CASCADE,
    git_recency REAL DEFAULT 0,
    git_frequency INTEGER DEFAULT 0,
    git_status_boost REAL DEFAULT 0,
    last_seen INTEGER DEFAULT 0
  )`,

  // Indexed directory roots and their metadata
  `CREATE TABLE IF NOT EXISTS watched_roots (
    root TEXT PRIMARY KEY,
    max_depth INTEGER DEFAULT 10,
    last_indexed INTEGER,
    file_count INTEGER
  )`,

  // Indexes for efficient queries
  `CREATE INDEX IF NOT EXISTS idx_files_meta_root ON files_meta(root)`,
  `CREATE INDEX IF NOT EXISTS idx_frecency_path ON frecency(path)`,
]

/**
 * FTS5 virtual table creation - must be handled separately since
 * SQLite FTS5 may not support IF NOT EXISTS in all versions.
 *
 * Uses unicode61 tokenizer with diacritics removal. The tokenizer
 * will split on hyphens and underscores (treating foo-bar as two tokens),
 * which is acceptable for path searching since we use prefix matching.
 */
const FTS5_TABLE_SQL = `CREATE VIRTUAL TABLE files_fts USING fts5(
  path,
  filename,
  dir_components,
  content=files_meta,
  content_rowid=rowid,
  tokenize="unicode61 remove_diacritics 1"
)`

/**
 * Triggers to keep FTS in sync with metadata table.
 */
const TRIGGER_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS files_meta_ai AFTER INSERT ON files_meta BEGIN
    INSERT INTO files_fts(rowid, path, filename, dir_components)
    VALUES (NEW.rowid, NEW.path, NEW.filename, NEW.dir_components);
  END`,

  `CREATE TRIGGER IF NOT EXISTS files_meta_ad AFTER DELETE ON files_meta BEGIN
    INSERT INTO files_fts(files_fts, rowid, path, filename, dir_components)
    VALUES ('delete', OLD.rowid, OLD.path, OLD.filename, OLD.dir_components);
  END`,

  `CREATE TRIGGER IF NOT EXISTS files_meta_au AFTER UPDATE ON files_meta BEGIN
    INSERT INTO files_fts(files_fts, rowid, path, filename, dir_components)
    VALUES ('delete', OLD.rowid, OLD.path, OLD.filename, OLD.dir_components);
    INSERT INTO files_fts(rowid, path, filename, dir_components)
    VALUES (NEW.rowid, NEW.path, NEW.filename, NEW.dir_components);
  END`,
]

// ============================================================================
// FTS5 Query Escaping
// ============================================================================

/**
 * Special characters that need normalization in FTS5 queries.
 *
 * FTS5 uses these characters for special syntax:
 * - Quotes (", ') for phrase queries
 * - Parentheses for grouping
 * - Asterisk for prefix matching
 * - Caret for column filtering
 * - Colon for column specification
 * - Plus/minus for boolean operators
 * - Pipe for OR
 * - Backslash is the escape character itself
 */
const FTS5_SPECIAL_CHARS = /["'\(\)\*\^\:\+\-\|\\/]/g

/**
 * Token separators used for FTS5 query normalization.
 *
 * Includes whitespace, path separators, and common filename delimiters.
 */
const FTS5_TOKEN_SEPARATORS = /[\s\/\\._-]+/g

interface QueryPart {
  readonly text: string
  readonly quoted: boolean
}

function splitQueryParts(query: string): QueryPart[] {
  const parts: QueryPart[] = []
  let buffer = ''
  let inQuote = false
  let quoteChar: '"' | "'" | '' = ''

  const flush = (quoted: boolean): void => {
    const value = buffer.trim()
    if (value) {
      parts.push({ text: value, quoted })
    }
    buffer = ''
  }

  for (const ch of query) {
    if (ch === '"' || ch === "'") {
      if (inQuote) {
        if (ch === quoteChar) {
          flush(true)
          inQuote = false
          quoteChar = ''
        } else {
          buffer += ch
        }
      } else {
        flush(false)
        inQuote = true
        quoteChar = ch
      }
      continue
    }

    if (!inQuote && /\s/.test(ch)) {
      flush(false)
      continue
    }

    buffer += ch
  }

  if (buffer.trim()) {
    parts.push({ text: buffer.trim(), quoted: inQuote })
  }

  return parts
}

function normalizeTokens(value: string): string[] {
  const normalized = value.replace(FTS5_SPECIAL_CHARS, ' ')
  return normalized.split(FTS5_TOKEN_SEPARATORS).filter(Boolean)
}

function buildEscapedTokens(query: string): { tokens: string[]; lastIsPhrase: boolean } {
  const trimmed = query.trim()
  if (!trimmed) {
    return { tokens: [], lastIsPhrase: false }
  }

  const parts = splitQueryParts(trimmed)
  const tokens: string[] = []
  let lastIsPhrase = false

  for (const part of parts) {
    const partTokens = normalizeTokens(part.text)
    if (partTokens.length === 0) {
      continue
    }

    if (part.quoted) {
      const phrase = partTokens.map(token => token.replace(/"/g, '""')).join(' ')
      tokens.push(`"${phrase}"`)
      lastIsPhrase = true
      continue
    }

    for (const token of partTokens) {
      const escaped = token.replace(/"/g, '""')
      tokens.push(`"${escaped}"`)
      lastIsPhrase = false
    }
  }

  return { tokens, lastIsPhrase }
}

/**
 * Escapes special FTS5 characters in a query string.
 *
 * Wraps each token in double quotes to treat them as literals,
 * preserving quoted phrases and splitting on common filename delimiters.
 *
 * @param query - Raw user query
 * @returns Escaped query safe for FTS5 MATCH
 *
 * @example
 * ```ts
 * escapeFTSQuery('src/comp') // '"src" "comp"'
 * escapeFTSQuery('my-component.tsx') // '"my" "component" "tsx"'
 * escapeFTSQuery('"my component"') // '"my component"'
 * ```
 */
export function escapeFTSQuery(query: string): string {
  return buildEscapedTokens(query).tokens.join(' ')
}

/**
 * Builds an FTS5 prefix query for path matching.
 *
 * Adds asterisk suffix to the last token for prefix matching,
 * which enables incremental search as the user types.
 *
 * @param query - Raw user query
 * @returns FTS5 query with prefix matching on last token
 *
 * @example
 * ```ts
 * buildPrefixQuery('src/comp')  // '"src" "comp"*'
 * buildPrefixQuery('button')    // '"button"*'
 * ```
 */
export function buildPrefixQuery(query: string): string {
  const { tokens, lastIsPhrase } = buildEscapedTokens(query)
  if (tokens.length === 0) {
    return ''
  }

  if (lastIsPhrase) {
    return tokens.join(' ')
  }

  const lastIndex = tokens.length - 1
  tokens[lastIndex] = `${tokens[lastIndex]}*`

  // Add prefix matching to the last token
  // The escaped query has tokens like: "token1" "token2" "token3"
  // We want: "token1" "token2" "token3"*
  return tokens.join(' ')
}

// ============================================================================
// LIKE Escaping
// ============================================================================

/**
 * Escapes special characters for SQLite LIKE queries.
 *
 * In LIKE patterns, '%' and '_' are wildcards, and '\' is the escape character.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Opens or creates the SQLite database with schema initialization.
 *
 * The database is created lazily on first access. Uses WAL mode for
 * concurrent reads during index updates.
 *
 * @param dbPath - Path to the database file (default: ~/.config/claude/file-picker/index.db)
 * @returns Open database connection
 * @throws DatabaseError if the database cannot be opened or schema fails
 *
 * @example
 * ```ts
 * const db = openDatabase();
 * try {
 *   const results = searchFiles(db, "component");
 * } finally {
 *   closeDatabase(db);
 * }
 * ```
 */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH): Database {
  try {
    const db = new Database(dbPath, { create: true })

    // Enable foreign keys
    db.exec('PRAGMA foreign_keys = ON;')

    // Initialize schema
    initializeSchema(db)

    return db
  } catch (err) {
    if (matchesErrorPattern(err, ErrorPatterns.DATABASE_LOCKED)) {
      throw DatabaseError.locked(dbPath)
    }
    throw DatabaseError.connectionFailed(
      dbPath,
      err instanceof Error ? err : new Error(String(err))
    )
  }
}

/**
 * Checks if a table exists in the database.
 */
function tableExists(db: Database, tableName: string): boolean {
  const result = db
    .query<
      { count: number },
      [string]
    >("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName)
  return (result?.count ?? 0) > 0
}

/**
 * Initializes the database schema if not already present.
 *
 * Uses a version check to support future migrations.
 * Handles FTS5 virtual table creation specially since it may not
 * support IF NOT EXISTS in all SQLite versions.
 *
 * @param db - Open database connection
 * @throws DatabaseError if schema initialization fails
 */
function initializeSchema(db: Database): void {
  try {
    // Enable WAL mode for concurrent reads
    db.exec('PRAGMA journal_mode = WAL')

    // Check if schema is already initialized
    const schemaExists = tableExists(db, 'schema_meta')

    if (!schemaExists) {
      // Fresh database - run full schema
      for (const stmt of SCHEMA_STATEMENTS) {
        db.exec(stmt)
      }

      // Create FTS5 virtual table (doesn't support IF NOT EXISTS reliably)
      db.exec(FTS5_TABLE_SQL)

      // Create triggers
      for (const stmt of TRIGGER_STATEMENTS) {
        db.exec(stmt)
      }

      // Record schema version
      db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
        'version',
        String(SCHEMA_VERSION)
      )
    } else {
      // Existing database - check if FTS5 table exists
      const ftsExists = tableExists(db, 'files_fts')
      if (!ftsExists) {
        // FTS5 table missing - recreate it and triggers
        db.exec(FTS5_TABLE_SQL)
        for (const stmt of TRIGGER_STATEMENTS) {
          db.exec(stmt)
        }
      }

      // Check version for potential migrations
      const versionRow = db
        .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key = 'version'")
        .get()

      const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0

      if (currentVersion < SCHEMA_VERSION) {
        // Future: run migrations here
        db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(
          String(SCHEMA_VERSION),
          'version'
        )
      }
    }
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Closes the database connection.
 *
 * @param db - Database connection to close
 */
export function closeDatabase(db: Database): void {
  try {
    db.close()
  } catch (err) {
    // Ignore errors on close - database may already be closed
    console.warn(
      '[pickme] Warning closing database:',
      err instanceof Error ? err.message : String(err)
    )
  }
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Inserts or updates a single file in the index.
 *
 * Uses SQLite UPSERT (INSERT OR REPLACE) for atomic updates.
 * The FTS index is kept in sync via triggers.
 *
 * @param db - Open database connection
 * @param file - File metadata to insert/update
 * @throws DatabaseError if the operation fails
 *
 * @example
 * ```ts
 * upsertFile(db, {
 *   path: "/Users/mg/project/src/Button.tsx",
 *   filename: "Button.tsx",
 *   dirComponents: "Users mg project src",
 *   root: "/Users/mg/project",
 *   mtime: Date.now() / 1000,
 *   relativePath: "src/Button.tsx"
 * });
 * ```
 */
export function upsertFile(db: Database, file: FileMeta): void {
  try {
    const stmt = db.prepare(`
      INSERT INTO files_meta (path, filename, dir_components, root, mtime, relative_path)
      VALUES ($path, $filename, $dirComponents, $root, $mtime, $relativePath)
      ON CONFLICT(path) DO UPDATE SET
        filename = excluded.filename,
        dir_components = excluded.dir_components,
        root = excluded.root,
        mtime = excluded.mtime,
        relative_path = excluded.relative_path
    `)

    stmt.run({
      $path: file.path,
      $filename: file.filename,
      $dirComponents: file.dirComponents,
      $root: file.root,
      $mtime: file.mtime,
      $relativePath: file.relativePath,
    })
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Batch inserts or updates files in the index.
 *
 * Uses a transaction for atomicity and performance.
 * Much faster than individual inserts for bulk operations.
 *
 * @param db - Open database connection
 * @param files - Array of file metadata to insert/update
 * @throws DatabaseError if the operation fails
 *
 * @example
 * ```ts
 * upsertFiles(db, [
 *   { path: "/a/b.ts", filename: "b.ts", ... },
 *   { path: "/a/c.ts", filename: "c.ts", ... },
 * ]);
 * ```
 */
export function upsertFiles(db: Database, files: readonly FileMeta[]): void {
  if (files.length === 0) {
    return
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO files_meta (path, filename, dir_components, root, mtime, relative_path)
      VALUES ($path, $filename, $dirComponents, $root, $mtime, $relativePath)
      ON CONFLICT(path) DO UPDATE SET
        filename = excluded.filename,
        dir_components = excluded.dir_components,
        root = excluded.root,
        mtime = excluded.mtime,
        relative_path = excluded.relative_path
    `)

    db.exec('BEGIN IMMEDIATE')

    try {
      for (const file of files) {
        stmt.run({
          $path: file.path,
          $filename: file.filename,
          $dirComponents: file.dirComponents,
          $root: file.root,
          $mtime: file.mtime,
          $relativePath: file.relativePath,
        })
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Deletes files from the index by path.
 *
 * Uses a transaction for atomicity. The FTS index and frecency
 * records are cleaned up via triggers and foreign keys.
 *
 * @param db - Open database connection
 * @param paths - Array of absolute paths to delete
 * @throws DatabaseError if the operation fails
 */
export function deleteFiles(db: Database, paths: readonly string[]): void {
  if (paths.length === 0) {
    return
  }

  try {
    const stmt = db.prepare('DELETE FROM files_meta WHERE path = $path')

    db.exec('BEGIN IMMEDIATE')

    try {
      for (const path of paths) {
        stmt.run({ $path: path })
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

// ============================================================================
// Search Operations
// ============================================================================

/**
 * Searches files using FTS5 with frecency scoring.
 *
 * Combines FTS5 relevance with frecency scores for optimal ranking.
 * Supports path prefix filtering for project-scoped searches.
 *
 * @param db - Open database connection
 * @param query - Search query (will be escaped for FTS5)
 * @param options - Search options (path filters, limit)
 * @returns Array of search results sorted by combined score
 * @throws FTSSyntaxError if the query has syntax errors after escaping
 * @throws DatabaseError for other database errors
 *
 * @example
 * ```ts
 * const results = searchFiles(db, "button component", {
 *   pathFilters: ["/Users/mg/project"],
 *   limit: 20
 * });
 * ```
 */
export function searchFiles(
  db: Database,
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  const { pathFilters = [], limit = 50 } = options

  // Build FTS5 query with prefix matching
  const ftsQuery = buildPrefixQuery(query)
  if (!ftsQuery) {
    return []
  }

  try {
    // Build path filter clause
    let pathClause = ''
    const params: Record<string, string | number> = {
      $query: ftsQuery,
      $limit: limit,
    }

    if (pathFilters.length > 0) {
      const clauses = pathFilters.map((filter, i) => {
        params[`$filter${i}`] = escapeLikePattern(filter) + '%'
        return `m.path LIKE $filter${i} ESCAPE '\\'`
      })
      pathClause = `AND (${clauses.join(' OR ')})`
    }

    // Query combines FTS5 rank with frecency scores
    // bm25() returns negative values (more negative = better match)
    // We negate it and add frecency scores for final ranking
    const sql = `
      SELECT
        m.path,
        m.filename,
        m.relative_path as relativePath,
        (
          -bm25(files_fts) +
          COALESCE(f.git_recency, 0) +
          COALESCE(f.git_frequency, 0) * 0.1 +
          COALESCE(f.git_status_boost, 0)
        ) as score
      FROM files_fts
      JOIN files_meta m ON files_fts.rowid = m.rowid
      LEFT JOIN frecency f ON m.path = f.path
      WHERE files_fts MATCH $query
      ${pathClause}
      ORDER BY score DESC
      LIMIT $limit
    `

    const stmt = db.query<
      { path: string; filename: string; relativePath: string | null; score: number },
      Record<string, string | number>
    >(sql)

    const results = stmt.all(params)

    return results.map(row => ({
      path: row.path,
      filename: row.filename,
      relativePath: row.relativePath ?? row.path,
      score: row.score,
    }))
  } catch (err) {
    // Check for FTS5 syntax errors
    if (matchesErrorPattern(err, ErrorPatterns.FTS5_SYNTAX)) {
      throw FTSSyntaxError.fromSqliteError(
        err instanceof Error ? err : new Error(String(err)),
        query
      )
    }
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Lists files by extension without requiring an FTS query.
 * Used for glob-only filtering like @*.ts where no search term is provided.
 *
 * @param db - Open database connection
 * @param extension - File extension to filter by (e.g., ".ts", ".json")
 * @param options - Optional path filters and limit
 * @returns Array of matching files sorted by frecency score
 * @throws DatabaseError if the query fails
 */
export function listFilesByExtension(
  db: Database,
  extension: string,
  options: { pathFilters?: readonly string[]; limit?: number } = {}
): SearchResult[] {
  const { pathFilters = [], limit = 50 } = options

  try {
    // Build path filter clause
    let pathClause = ''
    const params: Record<string, string | number> = {
      $ext: `%${extension}`,
      $limit: limit,
    }

    if (pathFilters.length > 0) {
      const clauses = pathFilters.map((filter, i) => {
        params[`$filter${i}`] = escapeLikePattern(filter) + '%'
        return `m.path LIKE $filter${i} ESCAPE '\\'`
      })
      pathClause = `AND (${clauses.join(' OR ')})`
    }

    // Query files_meta directly, joining with frecency for scoring
    const sql = `
      SELECT
        m.path,
        m.filename,
        m.relative_path as relativePath,
        (
          COALESCE(f.git_recency, 0) +
          COALESCE(f.git_frequency, 0) * 0.1 +
          COALESCE(f.git_status_boost, 0)
        ) as score
      FROM files_meta m
      LEFT JOIN frecency f ON m.path = f.path
      WHERE m.filename LIKE $ext
      ${pathClause}
      ORDER BY score DESC, m.filename ASC
      LIMIT $limit
    `

    const stmt = db.query<
      { path: string; filename: string; relativePath: string | null; score: number },
      Record<string, string | number>
    >(sql)

    const results = stmt.all(params)

    return results.map(row => ({
      path: row.path,
      filename: row.filename,
      relativePath: row.relativePath ?? row.path,
      score: row.score,
    }))
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Lists files without requiring an FTS query.
 * Used for fuzzy search candidate selection.
 *
 * @param db - Open database connection
 * @param options - Optional path filters and limit
 * @returns Array of files sorted by frecency score
 * @throws DatabaseError if the query fails
 */
export function listFiles(
  db: Database,
  options: { pathFilters?: readonly string[]; limit?: number } = {}
): SearchResult[] {
  const { pathFilters = [], limit = 1000 } = options

  try {
    // Build path filter clause
    let pathClause = ''
    const params: Record<string, string | number> = {
      $limit: limit,
    }

    if (pathFilters.length > 0) {
      const clauses = pathFilters.map((filter, i) => {
        params[`$filter${i}`] = escapeLikePattern(filter) + '%'
        return `m.path LIKE $filter${i} ESCAPE '\\'`
      })
      pathClause = `AND (${clauses.join(' OR ')})`
    }

    const sql = `
      SELECT
        m.path,
        m.filename,
        m.relative_path as relativePath,
        (
          COALESCE(f.git_recency, 0) +
          COALESCE(f.git_frequency, 0) * 0.1 +
          COALESCE(f.git_status_boost, 0)
        ) as score
      FROM files_meta m
      LEFT JOIN frecency f ON m.path = f.path
      WHERE 1 = 1
      ${pathClause}
      ORDER BY score DESC, m.filename ASC
      LIMIT $limit
    `

    const stmt = db.query<
      { path: string; filename: string; relativePath: string | null; score: number },
      Record<string, string | number>
    >(sql)

    const results = stmt.all(params)

    return results.map(row => ({
      path: row.path,
      filename: row.filename,
      relativePath: row.relativePath ?? row.path,
      score: row.score,
    }))
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

// ============================================================================
// Watched Roots Operations
// ============================================================================

/**
 * Gets all watched root directories.
 *
 * @param db - Open database connection
 * @returns Array of watched root metadata
 * @throws DatabaseError if the query fails
 */
export function getWatchedRoots(db: Database): WatchedRoot[] {
  try {
    const rows = db
      .query<
        {
          root: string
          max_depth: number
          last_indexed: number | null
          file_count: number | null
        },
        []
      >('SELECT root, max_depth, last_indexed, file_count FROM watched_roots')
      .all()

    return rows.map(row => ({
      root: row.root,
      maxDepth: row.max_depth,
      lastIndexed: row.last_indexed,
      fileCount: row.file_count,
    }))
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Updates or inserts a watched root.
 *
 * @param db - Open database connection
 * @param root - Watched root metadata to upsert
 * @throws DatabaseError if the operation fails
 */
export function updateWatchedRoot(db: Database, root: WatchedRoot): void {
  try {
    const stmt = db.prepare(`
      INSERT INTO watched_roots (root, max_depth, last_indexed, file_count)
      VALUES ($root, $maxDepth, $lastIndexed, $fileCount)
      ON CONFLICT(root) DO UPDATE SET
        max_depth = excluded.max_depth,
        last_indexed = excluded.last_indexed,
        file_count = excluded.file_count
    `)

    stmt.run({
      $root: root.root,
      $maxDepth: root.maxDepth,
      $lastIndexed: root.lastIndexed,
      $fileCount: root.fileCount,
    })
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

// ============================================================================
// Frecency Operations
// ============================================================================

/**
 * Batch updates frecency records.
 *
 * Uses a transaction for atomicity and performance.
 * Records are upserted (inserted or updated).
 *
 * @param db - Open database connection
 * @param frecencies - Array of frecency records to upsert
 * @throws DatabaseError if the operation fails
 */
export function upsertFrecency(db: Database, frecencies: readonly FrecencyRecord[]): void {
  if (frecencies.length === 0) {
    return
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO frecency (path, git_recency, git_frequency, git_status_boost, last_seen)
      VALUES ($path, $gitRecency, $gitFrequency, $gitStatusBoost, $lastSeen)
      ON CONFLICT(path) DO UPDATE SET
        git_recency = excluded.git_recency,
        git_frequency = excluded.git_frequency,
        git_status_boost = excluded.git_status_boost,
        last_seen = excluded.last_seen
    `)

    db.exec('BEGIN IMMEDIATE')

    try {
      for (const record of frecencies) {
        stmt.run({
          $path: record.path,
          $gitRecency: record.gitRecency,
          $gitFrequency: record.gitFrequency,
          $gitStatusBoost: record.gitStatusBoost,
          $lastSeen: record.lastSeen,
        })
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Removes files from the index that no longer exist.
 *
 * Compares the database contents against a set of existing paths
 * and deletes any paths not in the set.
 *
 * @param db - Open database connection
 * @param existingPaths - Set of paths that still exist on disk
 * @returns Number of files pruned
 * @throws DatabaseError if the operation fails
 */
export function pruneDeletedFiles(db: Database, existingPaths: Set<string>): number {
  try {
    // Get all paths currently in the database
    const rows = db.query<{ path: string }, []>('SELECT path FROM files_meta').all()

    // Find paths to delete
    const pathsToDelete: string[] = []
    for (const row of rows) {
      if (!existingPaths.has(row.path)) {
        pathsToDelete.push(row.path)
      }
    }

    if (pathsToDelete.length === 0) {
      return 0
    }

    // Delete in a transaction
    deleteFiles(db, pathsToDelete)

    return pathsToDelete.length
  } catch (err) {
    throw DatabaseError.fromSqliteError(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Gets the default database path.
 *
 * @returns The default path for the index database
 */
export function getDefaultDbPath(): string {
  return DEFAULT_DB_PATH
}
