/**
 * Tests for daemon SQLite database utilities.
 *
 * @module daemon/db.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDaemonDb, openDaemonDb } from "./db";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary database path for testing.
 */
function createTempDbPath(): { dbPath: string; cleanup: () => void } {
	const tempDir = mkdtempSync(join(tmpdir(), "daemon-db-test-"));
	const dbPath = join(tempDir, "test-daemon.db");

	return {
		dbPath,
		cleanup: () => {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {
				// Ignore cleanup errors
			}
		},
	};
}

// ============================================================================
// openDaemonDb Tests
// ============================================================================

describe("openDaemonDb", () => {
	let tempDb: { dbPath: string; cleanup: () => void };
	let db: Database | null = null;

	beforeEach(() => {
		tempDb = createTempDbPath();
	});

	afterEach(() => {
		if (db) {
			db.close();
			db = null;
		}
		tempDb.cleanup();
	});

	test("applies WAL mode", () => {
		db = openDaemonDb(tempDb.dbPath);

		const result = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode;").get();
		expect(result?.journal_mode).toBe("wal");
	});

	test("applies cache_size (-65536)", () => {
		db = openDaemonDb(tempDb.dbPath);

		const result = db.query<{ cache_size: number }, []>("PRAGMA cache_size;").get();
		expect(result?.cache_size).toBe(-65536);
	});

	test("applies mmap_size (268435456)", () => {
		db = openDaemonDb(tempDb.dbPath);

		const result = db.query<{ mmap_size: number }, []>("PRAGMA mmap_size;").get();
		expect(result?.mmap_size).toBe(268435456);
	});

	test("applies synchronous = NORMAL", () => {
		db = openDaemonDb(tempDb.dbPath);

		const result = db.query<{ synchronous: number }, []>("PRAGMA synchronous;").get();
		// NORMAL = 1
		expect(result?.synchronous).toBe(1);
	});

	test("applies temp_store = MEMORY", () => {
		db = openDaemonDb(tempDb.dbPath);

		const result = db.query<{ temp_store: number }, []>("PRAGMA temp_store;").get();
		// MEMORY = 2
		expect(result?.temp_store).toBe(2);
	});

	test("applies busy_timeout (5000)", () => {
		db = openDaemonDb(tempDb.dbPath);

		const result = db.query<{ timeout: number }, []>("PRAGMA busy_timeout;").get();
		expect(result?.timeout).toBe(5000);
	});

	test("returns a working Database instance", () => {
		db = openDaemonDb(tempDb.dbPath);

		// Verify we can execute queries
		db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
		db.exec("INSERT INTO test (id) VALUES (1)");

		const result = db.query<{ id: number }, []>("SELECT id FROM test").get();
		expect(result?.id).toBe(1);
	});
});

// ============================================================================
// closeDaemonDb Tests
// ============================================================================

describe("closeDaemonDb", () => {
	let tempDb: { dbPath: string; cleanup: () => void };

	beforeEach(() => {
		tempDb = createTempDbPath();
	});

	afterEach(() => {
		tempDb.cleanup();
	});

	test("runs without error", () => {
		const db = openDaemonDb(tempDb.dbPath);

		// Create some data to have something to optimize
		db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, data TEXT)");
		db.exec("INSERT INTO test (id, data) VALUES (1, 'hello')");

		expect(() => closeDaemonDb(db)).not.toThrow();
	});

	test("closes the database connection", () => {
		const db = openDaemonDb(tempDb.dbPath);
		closeDaemonDb(db);

		// Attempting to query after close should throw
		expect(() => db.query("SELECT 1").get()).toThrow();
	});

	test("truncates WAL file", () => {
		const db = openDaemonDb(tempDb.dbPath);

		// Create some data to generate WAL entries
		db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
		for (let i = 0; i < 100; i++) {
			db.exec(`INSERT INTO test (id) VALUES (${i})`);
		}

		closeDaemonDb(db);

		// WAL checkpoint should have occurred - open a new connection to verify
		const verifyDb = new Database(tempDb.dbPath, { readonly: true });
		const result = verifyDb.query<{ id: number }, []>("SELECT COUNT(*) as id FROM test").get();
		expect(result?.id).toBe(100);
		verifyDb.close();
	});
});
