/**
 * Daemon serve command.
 *
 * Starts the pickme daemon for fast file search via Unix socket.
 *
 * @module cli/commands/serve
 */

import { parseArgs } from "node:util";
import { getConfigPath } from "../../config";
import {
	createInitialState,
	type DaemonState,
	handleRequest,
} from "../../daemon/handlers";
import { createLifecycle, type LifecycleManager } from "../../daemon/lifecycle";
import { createServer } from "../../daemon/server";
import { getSocketPath } from "../../daemon/socket-path";
import { createFilePicker, type FilePicker } from "../../index";
import { EXIT_SUCCESS, error, info, type OutputOptions } from "../core";

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed arguments for the serve command.
 */
export interface ServeArgs {
	/** Idle timeout in minutes (default: 30) */
	readonly idle: number;
	/** Custom socket path (optional) */
	readonly socket: string | undefined;
}

/**
 * Error thrown when argument parsing fails.
 */
export class ServeArgsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ServeArgsError";
	}
}

// ============================================================================
// Argument Parsing
// ============================================================================

/**
 * Parses command line arguments for the serve command.
 *
 * @param args - Command line arguments (after 'serve')
 * @returns Parsed arguments
 * @throws {ServeArgsError} If arguments are invalid
 *
 * @example
 * ```ts
 * const args = parseServeArgs(['--idle', '60', '--socket', '/tmp/my.sock']);
 * // args.idle === 60
 * // args.socket === '/tmp/my.sock'
 * ```
 */
export function parseServeArgs(args: readonly string[]): ServeArgs {
	try {
		const { values } = parseArgs({
			args: args as string[],
			options: {
				idle: {
					type: "string",
					short: "i",
					default: "30",
				},
				socket: {
					type: "string",
					short: "s",
				},
			},
			strict: false, // Allow unknown flags to pass through
			allowPositionals: true,
		});

		// Parse and validate idle timeout
		const idleStr = values.idle as string;
		const idle = Number(idleStr);

		if (Number.isNaN(idle)) {
			throw new ServeArgsError(
				`invalid idle value: "${idleStr}" is not a number`,
			);
		}

		if (idle <= 0) {
			throw new ServeArgsError(
				`invalid idle value: must be positive (got ${idle})`,
			);
		}

		if (!Number.isInteger(idle)) {
			throw new ServeArgsError(
				`invalid idle value: must be an integer (got ${idle})`,
			);
		}

		return {
			idle,
			socket: values.socket as string | undefined,
		};
	} catch (err) {
		if (err instanceof ServeArgsError) {
			throw err;
		}
		throw new ServeArgsError(err instanceof Error ? err.message : String(err));
	}
}

// ============================================================================
// Serve Command
// ============================================================================

/**
 * Starts the pickme daemon server.
 *
 * Creates a FilePicker instance, starts a Unix socket server,
 * and manages the daemon lifecycle with idle timeout.
 *
 * @param args - Command line arguments
 * @param flags - Global output flags
 * @returns Exit code (never returns normally, exits on shutdown)
 */
export async function cmdServe(
	args: readonly string[],
	flags: OutputOptions,
): Promise<number> {
	// Parse arguments
	let serveArgs: ServeArgs;
	try {
		serveArgs = parseServeArgs(args);
	} catch (err) {
		if (err instanceof ServeArgsError) {
			error(err.message, flags);
			return 2; // Usage error
		}
		throw err;
	}

	// Create FilePicker instance
	const configPath = getConfigPath();
	let picker: FilePicker;

	try {
		picker = await createFilePicker({ configPath });
	} catch (err) {
		error(
			`failed to create file picker: ${err instanceof Error ? err.message : String(err)}`,
			flags,
		);
		return 1;
	}

	// Create daemon state
	const state: DaemonState = createInitialState();

	// Determine socket path
	const socketPath = serveArgs.socket ?? getSocketPath();

	// Calculate idle timeout in milliseconds
	const idleMs = serveArgs.idle * 60 * 1000;

	// Variable to hold lifecycle reference for request handler
	let lifecycle: LifecycleManager | null = null;

	// Create server with request handler
	const server = createServer(async (request) => {
		// Bump activity on each request to prevent idle timeout
		lifecycle?.bumpActivity();

		// Handle the request
		return handleRequest(request, state, picker);
	}, socketPath);

	// Create lifecycle manager before starting server to avoid race condition
	// where requests could arrive before lifecycle is initialized
	lifecycle = createLifecycle(server, {
		idleMs,
		onShutdown: async () => {
			// Clean up FilePicker on shutdown
			await picker.close();
		},
	});

	// Start the server after lifecycle is ready
	try {
		server.start();
	} catch (err) {
		error(
			`failed to start server: ${err instanceof Error ? err.message : String(err)}`,
			flags,
		);
		await picker.close();
		return 1;
	}

	// Log startup info
	info(`pickme daemon started (PID: ${process.pid})`, flags);
	info(`  Socket: ${socketPath}`, flags);
	info(`  Idle timeout: ${serveArgs.idle} minutes`, flags);

	// Keep the process alive until lifecycle manager triggers shutdown
	// The lifecycle manager will call process.exit(0) on shutdown
	process.stdin.resume();

	// This line is never reached, but satisfies TypeScript
	return EXIT_SUCCESS;
}
