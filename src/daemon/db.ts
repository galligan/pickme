/**
 * Daemon SQLite database utilities with read-optimized pragmas.
 *
 * This module provides functions to open and close SQLite databases
 * with optimal settings for the daemon's read-heavy workload.
 *
 * @module daemon/db
 */

import { Database } from "bun:sqlite";

/**
 * Pragmas optimized for read-heavy workloads.
 *
 * - WAL mode: Better concurrency for reads
 * - synchronous NORMAL: Good durability/performance balance
 * - temp_store MEMORY: Faster temp operations
 * - cache_size -65536: 64MB page cache
 * - mmap_size 256MB: Memory-mapped I/O for large reads
 * - busy_timeout 5000: Wait up to 5s for locks
 */
const DAEMON_PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -65536;
  PRAGMA mmap_size = 268435456;
  PRAGMA busy_timeout = 5000;
`;

/**
 * Opens a SQLite database with daemon-optimized pragmas.
 *
 * @param dbPath - Path to the SQLite database file
 * @returns Database instance with read-optimized settings applied
 */
export function openDaemonDb(dbPath: string): Database {
	const db = new Database(dbPath, { create: true });
	db.exec(DAEMON_PRAGMAS);
	return db;
}

/**
 * Closes a daemon database with cleanup operations.
 *
 * Runs PRAGMA optimize to analyze query patterns, then
 * checkpoints and truncates the WAL file before closing.
 *
 * @param db - Database instance to close
 */
export function closeDaemonDb(db: Database): void {
	db.exec("PRAGMA optimize;");
	db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
	db.close();
}
