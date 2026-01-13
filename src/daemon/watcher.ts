/**
 * File watcher utilities for cache invalidation.
 *
 * This module provides:
 * - WatcherState: Track multiple root directory watchers with debouncing
 * - DbWatcherState: Watch database files for mtime changes
 *
 * @module daemon/watcher
 */

import { watch, statSync, type FSWatcher } from "node:fs";

// ============================================================================
// Constants
// ============================================================================

/** Debounce interval for file change events in milliseconds */
const DEBOUNCE_MS = 100;

// ============================================================================
// Root Watcher Types
// ============================================================================

/**
 * State for tracking multiple root directory watchers.
 */
export interface WatcherState {
	/** Map of root paths to their FSWatcher instances */
	watchers: Map<string, FSWatcher>;
	/** Active debounce timer (null when not debouncing) */
	debounceTimer: Timer | null;
}

// ============================================================================
// Root Watcher Functions
// ============================================================================

/**
 * Creates the initial watcher state.
 *
 * @returns Fresh watcher state with empty watchers map
 */
export function createWatcherState(): WatcherState {
	return { watchers: new Map(), debounceTimer: null };
}

/**
 * Sets up a recursive file watcher for a root directory.
 *
 * Debounces rapid file changes to avoid excessive callbacks.
 * If a watcher already exists for the root, does nothing.
 *
 * @param root - Root directory to watch
 * @param watcherState - Mutable watcher state
 * @param onGenChange - Callback invoked when files change (after debounce)
 */
export function setupRootWatcher(
	root: string,
	watcherState: WatcherState,
	onGenChange: () => void
): void {
	if (watcherState.watchers.has(root)) return;

	const watcher = watch(root, { recursive: true }, () => {
		if (watcherState.debounceTimer) clearTimeout(watcherState.debounceTimer);
		watcherState.debounceTimer = setTimeout(() => {
			watcherState.debounceTimer = null;
			onGenChange();
		}, DEBOUNCE_MS);
	});

	watcher.on("error", (err) => {
		console.warn(`[watcher] Error for ${root}: ${err.message}`);
		onGenChange(); // Bump on error as safety measure
	});

	watcherState.watchers.set(root, watcher);
}

/**
 * Closes the watcher for a specific root directory.
 *
 * @param root - Root directory to stop watching
 * @param watcherState - Mutable watcher state
 */
export function closeWatcher(root: string, watcherState: WatcherState): void {
	const watcher = watcherState.watchers.get(root);
	if (watcher) {
		watcher.close();
		watcherState.watchers.delete(root);
	}
}

/**
 * Closes all watchers and clears the debounce timer.
 *
 * @param watcherState - Mutable watcher state
 */
export function closeAllWatchers(watcherState: WatcherState): void {
	watcherState.watchers.forEach((watcher) => {
		watcher.close();
	});
	watcherState.watchers.clear();
	if (watcherState.debounceTimer) {
		clearTimeout(watcherState.debounceTimer);
		watcherState.debounceTimer = null;
	}
}

/**
 * Gets the number of active watchers.
 *
 * @param watcherState - Watcher state to query
 * @returns Number of active watchers
 */
export function getActiveWatcherCount(watcherState: WatcherState): number {
	return watcherState.watchers.size;
}

// ============================================================================
// Database Watcher Types
// ============================================================================

/**
 * State for tracking database file changes by mtime.
 */
export interface DbWatcherState {
	/** FSWatcher for the database file (null when not watching) */
	watcher: FSWatcher | null;
	/** Last known modification time in milliseconds */
	lastMtime: number;
}

// ============================================================================
// Database Watcher Functions
// ============================================================================

/**
 * Creates the initial database watcher state.
 *
 * @returns Fresh database watcher state
 */
export function createDbWatcherState(): DbWatcherState {
	return { watcher: null, lastMtime: 0 };
}

/**
 * Sets up a watcher for database file changes.
 *
 * Uses mtime comparison to detect actual modifications,
 * avoiding false positives from filesystem events.
 *
 * @param dbPath - Path to the database file
 * @param dbWatcherState - Mutable database watcher state
 * @param onDbChange - Callback invoked when database file changes
 */
export function setupDbWatcher(
	dbPath: string,
	dbWatcherState: DbWatcherState,
	onDbChange: () => void
): void {
	try {
		const stat = statSync(dbPath);
		dbWatcherState.lastMtime = stat.mtimeMs;
	} catch {
		dbWatcherState.lastMtime = 0;
	}

	dbWatcherState.watcher = watch(dbPath, () => {
		try {
			const stat = statSync(dbPath);
			if (stat.mtimeMs > dbWatcherState.lastMtime) {
				dbWatcherState.lastMtime = stat.mtimeMs;
				onDbChange();
			}
		} catch {
			// File might be mid-write, ignore
		}
	});

	dbWatcherState.watcher.on("error", () => {
		onDbChange(); // Trigger change check on error
	});
}

/**
 * Closes the database watcher.
 *
 * @param dbWatcherState - Mutable database watcher state
 */
export function closeDbWatcher(dbWatcherState: DbWatcherState): void {
	if (dbWatcherState.watcher) {
		dbWatcherState.watcher.close();
		dbWatcherState.watcher = null;
	}
}
