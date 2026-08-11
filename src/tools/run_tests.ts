import { runCommand } from "./run_command.js";

export interface RunTestsOptions {
	/** Overriding the default command turns this into an arbitrary/parameterized
	 * invocation — the Permission Scope Layer should treat that as irreversible,
	 * unlike the fixed default command. */
	command?: string;
	cwd?: string;
	timeoutMs?: number;
}

export interface RunTestsResult {
	passed: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

const DEFAULT_TEST_COMMAND = "npm test";

export async function runTests(options: RunTestsOptions = {}): Promise<RunTestsResult> {
	const { exitCode, stdout, stderr } = await runCommand(options.command ?? DEFAULT_TEST_COMMAND, {
		cwd: options.cwd,
		timeoutMs: options.timeoutMs,
	});
	return { passed: exitCode === 0, exitCode, stdout, stderr };
}
