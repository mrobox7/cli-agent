import { readFile as fsReadFile } from "node:fs/promises";

export interface ReadFileResult {
	ok: boolean;
	content?: string;
	error?: string;
}

export async function readFile(path: string): Promise<ReadFileResult> {
	try {
		const content = await fsReadFile(path, "utf-8");
		return { ok: true, content };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
