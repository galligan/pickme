/**
 * Tests for daemon file watcher utilities.
 *
 * @module daemon/watcher.test
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createWatcherState,
	setupRootWatcher,
	closeWatcher,
	closeAllWatchers,
	getActiveWatcherCount,
	createDbWatcherState,
	setupDbWatcher,
	closeDbWatcher,
	type WatcherState,
	type DbWatcherState,
} from "./watcher";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary directory for testing.
 */
async function createTempDir(prefix = "watcher-test-"): Promise<string> {
	return await mkdtemp(join(tmpdir(), prefix));
}

/**
 * Waits for a specified duration.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// WatcherState Tests
// ============================================================================

describe("createWatcherState", () => {
	test("returns empty state", () => {
		const state = createWatcherState();

		expect(state.watchers).toBeDefined();
		expect(state.watchers.size).toBe(0);
		expect(state.debounceTimer).toBeNull();
	});
});

describe("setupRootWatcher", () => {
	let tempDir: string;
	let watcherState: WatcherState;

	beforeEach(async () => {
		tempDir = await createTempDir();
		watcherState = createWatcherState();
	});

	afterEach(async () => {
		closeAllWatchers(watcherState);
		try {
			await rm(tempDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("adds watcher to map", () => {
		const callback = () => {};
		setupRootWatcher(tempDir, watcherState, callback);

		expect(watcherState.watchers.has(tempDir)).toBe(true);
		expect(watcherState.watchers.size).toBe(1);
	});

	test("does not duplicate watchers for same root", () => {
		const callback = () => {};
		setupRootWatcher(tempDir, watcherState, callback);
		setupRootWatcher(tempDir, watcherState, callback);

		expect(watcherState.watchers.size).toBe(1);
	});

	test("allows multiple watchers for different roots", async () => {
		const tempDir2 = await createTempDir("watcher-test-2-");
		const callback = () => {};

		try {
			setupRootWatcher(tempDir, watcherState, callback);
			setupRootWatcher(tempDir2, watcherState, callback);

			expect(watcherState.watchers.size).toBe(2);
		} finally {
			try {
				await rm(tempDir2, { recursive: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});
});

describe("closeWatcher", () => {
	let tempDir: string;
	let watcherState: WatcherState;

	beforeEach(async () => {
		tempDir = await createTempDir();
		watcherState = createWatcherState();
	});

	afterEach(async () => {
		closeAllWatchers(watcherState);
		try {
			await rm(tempDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("removes watcher from map", () => {
		const callback = () => {};
		setupRootWatcher(tempDir, watcherState, callback);

		expect(watcherState.watchers.has(tempDir)).toBe(true);

		closeWatcher(tempDir, watcherState);

		expect(watcherState.watchers.has(tempDir)).toBe(false);
	});

	test("handles non-existent watcher gracefully", () => {
		// Should not throw
		closeWatcher("/non/existent/path", watcherState);
		expect(watcherState.watchers.size).toBe(0);
	});
});

describe("closeAllWatchers", () => {
	let tempDir: string;
	let tempDir2: string;
	let watcherState: WatcherState;

	beforeEach(async () => {
		tempDir = await createTempDir();
		tempDir2 = await createTempDir("watcher-test-2-");
		watcherState = createWatcherState();
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
		try {
			await rm(tempDir2, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("clears all watchers", () => {
		const callback = () => {};
		setupRootWatcher(tempDir, watcherState, callback);
		setupRootWatcher(tempDir2, watcherState, callback);

		expect(watcherState.watchers.size).toBe(2);

		closeAllWatchers(watcherState);

		expect(watcherState.watchers.size).toBe(0);
	});

	test("clears debounce timer", async () => {
		const callback = () => {};
		setupRootWatcher(tempDir, watcherState, callback);

		// Trigger a file change to start debounce timer
		await writeFile(join(tempDir, "test.txt"), "content");
		await sleep(50); // Let the watcher detect the change

		closeAllWatchers(watcherState);

		expect(watcherState.debounceTimer).toBeNull();
	});
});

describe("getActiveWatcherCount", () => {
	let tempDir: string;
	let watcherState: WatcherState;

	beforeEach(async () => {
		tempDir = await createTempDir();
		watcherState = createWatcherState();
	});

	afterEach(async () => {
		closeAllWatchers(watcherState);
		try {
			await rm(tempDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("returns correct count", async () => {
		const tempDir2 = await createTempDir("watcher-test-2-");
		const callback = () => {};

		try {
			expect(getActiveWatcherCount(watcherState)).toBe(0);

			setupRootWatcher(tempDir, watcherState, callback);
			expect(getActiveWatcherCount(watcherState)).toBe(1);

			setupRootWatcher(tempDir2, watcherState, callback);
			expect(getActiveWatcherCount(watcherState)).toBe(2);

			closeWatcher(tempDir, watcherState);
			expect(getActiveWatcherCount(watcherState)).toBe(1);

			closeAllWatchers(watcherState);
			expect(getActiveWatcherCount(watcherState)).toBe(0);
		} finally {
			try {
				await rm(tempDir2, { recursive: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});
});

describe("file change detection", () => {
	let tempDir: string;
	let watcherState: WatcherState;

	beforeEach(async () => {
		tempDir = await createTempDir();
		watcherState = createWatcherState();
	});

	afterEach(async () => {
		closeAllWatchers(watcherState);
		try {
			await rm(tempDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("triggers callback on file change", async () => {
		let callCount = 0;
		const callback = () => {
			callCount++;
		};

		setupRootWatcher(tempDir, watcherState, callback);

		// Wait for watcher to be fully set up
		await sleep(50);

		// Trigger a file change
		await writeFile(join(tempDir, "test.txt"), "content");

		// Wait for debounce (100ms) + extra buffer
		await sleep(200);

		expect(callCount).toBeGreaterThanOrEqual(1);
	});

	test("rapid changes only trigger callback once due to debounce", async () => {
		let callCount = 0;
		const callback = () => {
			callCount++;
		};

		setupRootWatcher(tempDir, watcherState, callback);

		// Wait for watcher to be fully set up
		await sleep(50);

		// Trigger multiple rapid file changes
		await writeFile(join(tempDir, "test1.txt"), "content1");
		await sleep(20);
		await writeFile(join(tempDir, "test2.txt"), "content2");
		await sleep(20);
		await writeFile(join(tempDir, "test3.txt"), "content3");

		// Wait for debounce (100ms) + extra buffer
		await sleep(200);

		// Should only have triggered once due to debouncing
		expect(callCount).toBe(1);
	});

	test("nested file changes are detected", async () => {
		let callCount = 0;
		const callback = () => {
			callCount++;
		};

		// Create nested directory
		const nestedDir = join(tempDir, "nested");
		await mkdir(nestedDir);

		setupRootWatcher(tempDir, watcherState, callback);

		// Wait for watcher to be fully set up
		await sleep(50);

		// Trigger a file change in nested directory
		await writeFile(join(nestedDir, "test.txt"), "content");

		// Wait for debounce (100ms) + extra buffer
		await sleep(200);

		expect(callCount).toBeGreaterThanOrEqual(1);
	});
});

// ============================================================================
// DbWatcherState Tests
// ============================================================================

describe("createDbWatcherState", () => {
	test("returns empty state", () => {
		const state = createDbWatcherState();

		expect(state.watcher).toBeNull();
		expect(state.lastMtime).toBe(0);
	});
});

describe("setupDbWatcher", () => {
	let tempDir: string;
	let dbPath: string;
	let dbWatcherState: DbWatcherState;

	beforeEach(async () => {
		tempDir = await createTempDir("db-watcher-test-");
		dbPath = join(tempDir, "test.db");
		// Create the db file
		await writeFile(dbPath, "initial content");
		dbWatcherState = createDbWatcherState();
	});

	afterEach(async () => {
		closeDbWatcher(dbWatcherState);
		try {
			await rm(tempDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("sets up watcher", () => {
		const callback = () => {};
		setupDbWatcher(dbPath, dbWatcherState, callback);

		expect(dbWatcherState.watcher).not.toBeNull();
	});

	test("initializes lastMtime from file", async () => {
		const callback = () => {};
		setupDbWatcher(dbPath, dbWatcherState, callback);

		expect(dbWatcherState.lastMtime).toBeGreaterThan(0);
	});

	test("triggers callback on mtime change", async () => {
		let callCount = 0;
		const callback = () => {
			callCount++;
		};

		setupDbWatcher(dbPath, dbWatcherState, callback);

		// Wait for watcher to be fully set up
		await sleep(50);

		// Modify the file
		await writeFile(dbPath, "modified content");

		// Wait for watcher to detect change
		await sleep(200);

		expect(callCount).toBeGreaterThanOrEqual(1);
	});

	test("updates lastMtime after change", async () => {
		const callback = () => {};
		setupDbWatcher(dbPath, dbWatcherState, callback);

		const initialMtime = dbWatcherState.lastMtime;

		// Wait a bit to ensure different mtime
		await sleep(50);

		// Modify the file
		await writeFile(dbPath, "modified content");

		// Wait for watcher to detect change
		await sleep(200);

		expect(dbWatcherState.lastMtime).toBeGreaterThan(initialMtime);
	});
});

describe("closeDbWatcher", () => {
	let tempDir: string;
	let dbPath: string;
	let dbWatcherState: DbWatcherState;

	beforeEach(async () => {
		tempDir = await createTempDir("db-watcher-test-");
		dbPath = join(tempDir, "test.db");
		await writeFile(dbPath, "initial content");
		dbWatcherState = createDbWatcherState();
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("closes watcher and sets to null", () => {
		const callback = () => {};
		setupDbWatcher(dbPath, dbWatcherState, callback);

		expect(dbWatcherState.watcher).not.toBeNull();

		closeDbWatcher(dbWatcherState);

		expect(dbWatcherState.watcher).toBeNull();
	});

	test("handles already null watcher gracefully", () => {
		// Should not throw
		closeDbWatcher(dbWatcherState);
		expect(dbWatcherState.watcher).toBeNull();
	});
});
