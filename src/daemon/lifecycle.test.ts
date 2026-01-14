/**
 * Tests for daemon lifecycle management.
 *
 * @module daemon/lifecycle.test
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createLifecycle, type LifecycleManager } from "./lifecycle";
import type { DaemonServer } from "./server";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a mock DaemonServer for testing.
 */
function createMockServer(): DaemonServer & { stopCalls: number } {
	const mockServer = {
		socketPath: "/tmp/test.sock",
		stopCalls: 0,

		start(): void {
			// No-op
		},

		async stop(): Promise<void> {
			mockServer.stopCalls++;
		},

		isRunning(): boolean {
			return true;
		},
	};

	return mockServer;
}

// ============================================================================
// createLifecycle Tests
// ============================================================================

describe("createLifecycle", () => {
	let mockServer: DaemonServer & { stopCalls: number };
	let lifecycle: LifecycleManager;
	let exitSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		mockServer = createMockServer();
		// Mock process.exit to prevent actual exit during tests
		exitSpy = spyOn(process, "exit").mockImplementation(
			() => undefined as never,
		);
	});

	afterEach(() => {
		exitSpy.mockRestore();
	});

	test("returns manager interface", () => {
		lifecycle = createLifecycle(mockServer, { idleMs: 30000 });

		expect(lifecycle).toBeDefined();
		expect(typeof lifecycle.bumpActivity).toBe("function");
		expect(typeof lifecycle.shutdown).toBe("function");
		expect(typeof lifecycle.isShuttingDown).toBe("boolean");
	});

	test("isShuttingDown is initially false", () => {
		lifecycle = createLifecycle(mockServer, { idleMs: 30000 });

		expect(lifecycle.isShuttingDown).toBe(false);
	});
});

// ============================================================================
// bumpActivity Tests
// ============================================================================

describe("LifecycleManager.bumpActivity", () => {
	let mockServer: DaemonServer & { stopCalls: number };
	let lifecycle: LifecycleManager;
	let exitSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		mockServer = createMockServer();
		exitSpy = spyOn(process, "exit").mockImplementation(
			() => undefined as never,
		);
	});

	afterEach(() => {
		exitSpy.mockRestore();
	});

	test("does not throw", () => {
		lifecycle = createLifecycle(mockServer, { idleMs: 30000 });

		expect(() => lifecycle.bumpActivity()).not.toThrow();
	});

	test("can be called multiple times", () => {
		lifecycle = createLifecycle(mockServer, { idleMs: 30000 });

		lifecycle.bumpActivity();
		lifecycle.bumpActivity();
		lifecycle.bumpActivity();

		// Should not throw or cause issues
		expect(lifecycle.isShuttingDown).toBe(false);
	});
});

// ============================================================================
// shutdown Tests
// ============================================================================

describe("LifecycleManager.shutdown", () => {
	let mockServer: DaemonServer & { stopCalls: number };
	let lifecycle: LifecycleManager;
	let exitSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		mockServer = createMockServer();
		exitSpy = spyOn(process, "exit").mockImplementation(
			() => undefined as never,
		);
	});

	afterEach(() => {
		exitSpy.mockRestore();
	});

	test("calls onShutdown hook", async () => {
		let hookCalled = false;
		lifecycle = createLifecycle(mockServer, {
			idleMs: 30000,
			onShutdown: async () => {
				hookCalled = true;
			},
		});

		await lifecycle.shutdown();

		expect(hookCalled).toBe(true);
	});

	test("stops the server", async () => {
		lifecycle = createLifecycle(mockServer, { idleMs: 30000 });

		await lifecycle.shutdown();

		expect(mockServer.stopCalls).toBe(1);
	});

	test("sets isShuttingDown to true", async () => {
		lifecycle = createLifecycle(mockServer, { idleMs: 30000 });

		expect(lifecycle.isShuttingDown).toBe(false);

		await lifecycle.shutdown();

		expect(lifecycle.isShuttingDown).toBe(true);
	});

	test("is idempotent - second call has no effect", async () => {
		let hookCallCount = 0;
		lifecycle = createLifecycle(mockServer, {
			idleMs: 30000,
			onShutdown: async () => {
				hookCallCount++;
			},
		});

		await lifecycle.shutdown();
		await lifecycle.shutdown();
		await lifecycle.shutdown();

		expect(hookCallCount).toBe(1);
		expect(mockServer.stopCalls).toBe(1);
	});

	test("calls process.exit(0)", async () => {
		lifecycle = createLifecycle(mockServer, { idleMs: 30000 });

		await lifecycle.shutdown();

		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	test("handles onShutdown errors gracefully", async () => {
		lifecycle = createLifecycle(mockServer, {
			idleMs: 30000,
			onShutdown: async () => {
				throw new Error("Shutdown hook failed");
			},
		});

		// Should not throw
		await expect(lifecycle.shutdown()).resolves.toBeUndefined();
		expect(mockServer.stopCalls).toBe(1);
	});
});

// ============================================================================
// Idle Timer Tests
// ============================================================================

describe("LifecycleManager idle timer", () => {
	let mockServer: DaemonServer & { stopCalls: number };
	let exitSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		mockServer = createMockServer();
		exitSpy = spyOn(process, "exit").mockImplementation(
			() => undefined as never,
		);
	});

	afterEach(() => {
		exitSpy.mockRestore();
	});

	test("fires after configured idle time", async () => {
		const idleMs = 50; // Very short for testing

		const lifecycle = createLifecycle(mockServer, { idleMs });

		// Wait for idle timeout
		await Bun.sleep(idleMs + 50);

		expect(lifecycle.isShuttingDown).toBe(true);
		expect(mockServer.stopCalls).toBe(1);
	});

	test("activity bump prevents immediate shutdown", async () => {
		const idleMs = 50;

		const lifecycle = createLifecycle(mockServer, { idleMs });

		// Bump activity before idle timeout
		await Bun.sleep(30);
		lifecycle.bumpActivity();

		// Original timeout would have fired, but activity was bumped
		await Bun.sleep(30);

		// Should still be running since we bumped activity
		// The timer reschedules based on last activity time
		expect(lifecycle.isShuttingDown).toBe(false);
	});
});
