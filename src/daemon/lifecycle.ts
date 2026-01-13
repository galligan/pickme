/**
 * Lifecycle management for the pickme daemon.
 *
 * Handles idle timeout, signal handling, and graceful shutdown.
 *
 * @module daemon/lifecycle
 */

import type { DaemonServer } from "./server";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a lifecycle manager.
 */
export interface LifecycleOptions {
	/** Idle timeout in milliseconds before automatic shutdown */
	readonly idleMs: number;
	/** Optional callback invoked during shutdown before server stops */
	readonly onShutdown?: () => Promise<void>;
}

/**
 * Lifecycle manager interface for controlling daemon lifecycle.
 */
export interface LifecycleManager {
	/**
	 * Bumps the last activity time to prevent idle timeout.
	 * Call this after each request is processed.
	 */
	bumpActivity(): void;

	/**
	 * Initiates graceful shutdown.
	 * Calls onShutdown hook, clears timers, stops server, and exits.
	 * Idempotent - safe to call multiple times.
	 */
	shutdown(): Promise<void>;

	/**
	 * Returns whether shutdown has been initiated.
	 */
	readonly isShuttingDown: boolean;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Creates a lifecycle manager for the daemon.
 *
 * The lifecycle manager handles:
 * - Idle timeout: Shuts down after idleMs of inactivity
 * - Signal handling: Graceful shutdown on SIGINT, SIGTERM, SIGHUP
 * - Shutdown hook: Calls onShutdown before stopping the server
 *
 * @param server - The daemon server instance to manage
 * @param options - Lifecycle configuration
 * @returns A LifecycleManager instance
 *
 * @example
 * ```ts
 * const server = createServer(handler);
 * const lifecycle = createLifecycle(server, {
 *   idleMs: 30 * 60 * 1000, // 30 minutes
 *   onShutdown: async () => {
 *     console.log('Shutting down...');
 *   },
 * });
 *
 * server.start();
 *
 * // After each request:
 * lifecycle.bumpActivity();
 * ```
 */
export function createLifecycle(
	server: DaemonServer,
	options: LifecycleOptions,
): LifecycleManager {
	const { idleMs, onShutdown } = options;

	let lastActivityTime = Date.now();
	let idleTimer: Timer | null = null;
	let shuttingDown = false;

	/**
	 * Schedules the idle timer.
	 * Clears any existing timer and sets a new one.
	 */
	function scheduleIdleTimer(): void {
		if (idleTimer !== null) {
			clearTimeout(idleTimer);
		}

		idleTimer = setTimeout(() => {
			// Check if we're actually idle
			const elapsed = Date.now() - lastActivityTime;
			if (elapsed >= idleMs) {
				void manager.shutdown();
			} else {
				// Activity happened, reschedule
				scheduleIdleTimer();
			}
		}, idleMs);
	}

	/**
	 * Signal handler for graceful shutdown.
	 */
	function handleSignal(_signal: string): void {
		if (shuttingDown) return;
		void manager.shutdown();
	}

	// Set up signal handlers
	process.on("SIGINT", () => handleSignal("SIGINT"));
	process.on("SIGTERM", () => handleSignal("SIGTERM"));
	process.on("SIGHUP", () => handleSignal("SIGHUP"));

	// Start the idle timer
	scheduleIdleTimer();

	const manager: LifecycleManager = {
		bumpActivity(): void {
			lastActivityTime = Date.now();
		},

		async shutdown(): Promise<void> {
			if (shuttingDown) {
				return;
			}
			shuttingDown = true;

			// Clear idle timer
			if (idleTimer !== null) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}

			// Call shutdown hook
			if (onShutdown) {
				try {
					await onShutdown();
				} catch {
					// Ignore shutdown hook errors
				}
			}

			// Stop the server
			await server.stop();

			// Exit the process
			process.exit(0);
		},

		get isShuttingDown(): boolean {
			return shuttingDown;
		},
	};

	return manager;
}
