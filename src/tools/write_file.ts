import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WriteFileResult {
	ok: boolean;
	error?: string;
}

export async function writeFile(path: string, content: string): Promise<WriteFileResult> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await fsWriteFile(path, content, "utf-8");
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
