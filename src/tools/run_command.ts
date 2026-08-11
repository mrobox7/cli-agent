import { exec } from "node:child_process";

export interface RunCommandOptions {
	cwd?: string;
	timeoutMs?: number;
}

export interface RunCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export function runCommand(command: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
	return new Promise((resolve) => {
		exec(
			command,
			{
				cwd: options.cwd,
				timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: MAX_BUFFER_BYTES,
			},
			(error, stdout, stderr) => {
				const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ exitCode, stdout, stderr });
			},
		);
	});
}
