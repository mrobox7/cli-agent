import { execFile, type ExecFileException } from "node:child_process";

export interface SearchMatch {
	file: string;
	line: number;
	text: string;
}

export interface SearchFilesOptions {
	/** File or directory to search. Defaults to the current directory. */
	path?: string;
	/** Case-insensitive match. */
	ignoreCase?: boolean;
	/** Treat `pattern` as a literal string instead of a regex. */
	literal?: boolean;
	/** Only search files matching this glob, e.g. "*.ts". */
	globPattern?: string;
	/** Cap the number of matches returned. */
	maxResults?: number;
}

export interface SearchFilesResult {
	ok: boolean;
	matches: SearchMatch[];
	truncated: boolean;
	error?: string;
}

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_EXCLUDE_DIRS = [".git", "node_modules", "dist", "build"];
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// grep exit codes: 0 = matches found, 1 = no matches (not an error), 2+ = real error.
export function searchFiles(pattern: string, options: SearchFilesOptions = {}): Promise<SearchFilesResult> {
	const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
	const args = ["-r", "-n", "-H", "-I"];
	if (options.ignoreCase) args.push("-i");
	if (options.literal) args.push("-F");
	if (options.globPattern) args.push(`--include=${options.globPattern}`);
	for (const dir of DEFAULT_EXCLUDE_DIRS) args.push(`--exclude-dir=${dir}`);
	args.push("--", pattern, options.path ?? ".");

	return new Promise((resolve) => {
		execFile("grep", args, { maxBuffer: MAX_BUFFER_BYTES }, (error: ExecFileException | null, stdout: string) => {
			const exitCode = error ? (typeof error.code === "number" ? error.code : 2) : 0;
			if (exitCode >= 2) {
				resolve({
					ok: false,
					matches: [],
					truncated: false,
					error: error?.message ?? `grep exited with code ${exitCode}`,
				});
				return;
			}

			const lines = stdout.split("\n").filter((line: string) => line.length > 0);
			const matches: SearchMatch[] = [];
			for (const line of lines) {
				const match = /^(.*?):(\d+):(.*)$/s.exec(line);
				if (!match) continue;
				matches.push({ file: match[1], line: Number(match[2]), text: match[3] });
			}

			resolve({
				ok: true,
				matches: matches.slice(0, maxResults),
				truncated: matches.length > maxResults,
			});
		});
	});
}
