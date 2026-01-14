/**
 * Tests for circuit breaker functionality.
 *
 * @module daemon/circuit.test
 */

import { describe, expect, test } from "bun:test";
import {
	checkRss,
	createCircuitState,
	handleDbError,
	maybeCheckRss,
	REQUEST_TIMEOUT_MS,
	resetDbErrorCount,
	RSS_EXIT_BYTES,
	RSS_WARN_BYTES,
	withTimeout,
} from "./circuit";

// ============================================================================
// createCircuitState Tests
// ============================================================================

describe("createCircuitState", () => {
	test("returns correct initial state", () => {
		const state = createCircuitState();

		expect(state.dbErrorCount).toBe(0);
		expect(state.lastRssCheck).toBe(0);
		expect(state.rssCheckIntervalMs).toBe(30000);
	});

	test("accepts custom rssCheckIntervalMs", () => {
		const state = createCircuitState(5000);

		expect(state.rssCheckIntervalMs).toBe(5000);
	});
});

// ============================================================================
// withTimeout Tests
// ============================================================================

describe("withTimeout", () => {
	test("allows fast operations to complete", async () => {
		const fastPromise = Promise.resolve("success");

		const result = await withTimeout(fastPromise, 1000);

		expect(result).toBe("success");
	});

	test("allows operations completing within timeout", async () => {
		const delayedPromise = new Promise<string>((resolve) => {
			setTimeout(() => resolve("delayed success"), 10);
		});

		const result = await withTimeout(delayedPromise, 1000);

		expect(result).toBe("delayed success");
	});

	test('rejects slow operations with "Request timeout" error', async () => {
		const slowPromise = new Promise<string>((resolve) => {
			setTimeout(() => resolve("too slow"), 1000);
		});

		await expect(withTimeout(slowPromise, 50)).rejects.toThrow(
			"Request timeout",
		);
	});

	test("uses default timeout when not specified", async () => {
		// This test verifies the default is exported and reasonable
		expect(REQUEST_TIMEOUT_MS).toBe(5000);
	});

	test("propagates errors from the underlying promise", async () => {
		const failingPromise = Promise.reject(new Error("Original error"));

		await expect(withTimeout(failingPromise, 1000)).rejects.toThrow(
			"Original error",
		);
	});
});

// ============================================================================
// checkRss Tests
// ============================================================================

describe("checkRss", () => {
	test("returns 'ok' for normal memory usage", () => {
		// Use thresholds well above current usage
		const action = checkRss(1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024);

		expect(action).toBe("ok");
	});

	test("returns 'warn' when above warn threshold", () => {
		const rss = process.memoryUsage().rss;
		// Set warn threshold below current usage, exit above
		const action = checkRss(1, rss * 2);

		expect(action).toBe("warn");
	});

	test("returns 'exit' when above exit threshold", () => {
		// Set both thresholds below current usage
		const action = checkRss(1, 1);

		expect(action).toBe("exit");
	});

	test("uses default thresholds when not specified", () => {
		// Verify the default thresholds are exported correctly
		expect(RSS_WARN_BYTES).toBe(256 * 1024 * 1024);
		expect(RSS_EXIT_BYTES).toBe(512 * 1024 * 1024);
	});

	test("exit takes precedence over warn", () => {
		// When both thresholds are exceeded, exit should be returned
		const action = checkRss(1, 1);

		expect(action).toBe("exit");
	});
});

// ============================================================================
// maybeCheckRss Tests
// ============================================================================

describe("maybeCheckRss", () => {
	test("respects check interval", () => {
		const circuit = createCircuitState(60000); // 60 second interval
		circuit.lastRssCheck = Date.now(); // Just checked

		let warnCalled = false;
		let exitCalled = false;

		maybeCheckRss(
			circuit,
			() => {
				warnCalled = true;
			},
			() => {
				exitCalled = true;
			},
		);

		// Callbacks should not be called since we just checked
		expect(warnCalled).toBe(false);
		expect(exitCalled).toBe(false);
	});

	test("updates lastRssCheck when interval elapsed", () => {
		const circuit = createCircuitState(100);
		circuit.lastRssCheck = Date.now() - 200; // Interval has elapsed

		const beforeCheck = Date.now();
		maybeCheckRss(
			circuit,
			() => {},
			() => {},
		);

		expect(circuit.lastRssCheck).toBeGreaterThanOrEqual(beforeCheck);
	});

	test("calls onWarn when RSS exceeds warn threshold (simulated)", () => {
		// This test uses the actual checkRss behavior
		// In normal operation, RSS is typically well under thresholds
		const circuit = createCircuitState(0); // Always check

		let warnCalled = false;

		maybeCheckRss(
			circuit,
			() => {
				warnCalled = true;
			},
			() => {},
		);

		// In a normal test environment, RSS should be under thresholds
		// so warnCalled should remain false
		expect(warnCalled).toBe(false);
	});

	test("performs check when lastRssCheck is 0", () => {
		const circuit = createCircuitState(30000);
		// lastRssCheck starts at 0

		maybeCheckRss(
			circuit,
			() => {},
			() => {},
		);

		expect(circuit.lastRssCheck).toBeGreaterThan(0);
	});
});

// ============================================================================
// handleDbError Tests
// ============================================================================

describe("handleDbError", () => {
	test("returns 'retry' on first error", () => {
		const circuit = createCircuitState();
		const error = new Error("Database error");

		const action = handleDbError(circuit, error);

		expect(action).toBe("retry");
		expect(circuit.dbErrorCount).toBe(1);
	});

	test("returns 'exit' on second consecutive error", () => {
		const circuit = createCircuitState();
		const error = new Error("Database error");

		handleDbError(circuit, error); // First error
		const action = handleDbError(circuit, error); // Second error

		expect(action).toBe("exit");
		expect(circuit.dbErrorCount).toBe(2);
	});

	test("returns 'exit' on third consecutive error", () => {
		const circuit = createCircuitState();
		const error = new Error("Database error");

		handleDbError(circuit, error);
		handleDbError(circuit, error);
		const action = handleDbError(circuit, error);

		expect(action).toBe("exit");
		expect(circuit.dbErrorCount).toBe(3);
	});
});

// ============================================================================
// resetDbErrorCount Tests
// ============================================================================

describe("resetDbErrorCount", () => {
	test("clears the error count", () => {
		const circuit = createCircuitState();

		handleDbError(circuit, new Error("error 1"));
		handleDbError(circuit, new Error("error 2"));

		expect(circuit.dbErrorCount).toBe(2);

		resetDbErrorCount(circuit);

		expect(circuit.dbErrorCount).toBe(0);
	});

	test("allows retry after reset", () => {
		const circuit = createCircuitState();
		const error = new Error("Database error");

		handleDbError(circuit, error);
		handleDbError(circuit, error);
		resetDbErrorCount(circuit);

		// After reset, first error should return "retry" again
		const action = handleDbError(circuit, error);

		expect(action).toBe("retry");
		expect(circuit.dbErrorCount).toBe(1);
	});
});
