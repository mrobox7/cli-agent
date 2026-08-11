import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SearchFilesOptions } from "./tools/search_files.js";
import type { RunCommandOptions } from "./tools/run_command.js";
import type { RunTestsOptions } from "./tools/run_tests.js";
import type { PlanStep } from "./tools/updatePlan.js";

export type ToolCall =
	| { tool: "read_file"; path: string }
	| { tool: "search_files"; pattern: string; options?: SearchFilesOptions }
	| { tool: "write_file"; path: string; content: string }
	| { tool: "run_tests"; options?: RunTestsOptions }
	| { tool: "run_command"; command: string; options?: RunCommandOptions }
	| { tool: "delegate_task"; subagent: string; task: string }
	| { tool: "update_plan"; steps: PlanStep[] };

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionResult {
	decision: PermissionDecision;
	reason: string;
}

export function checkPermission(call: ToolCall, projectDir: string = process.cwd()): PermissionResult {
	switch (call.tool) {
		case "read_file":
		case "search_files":
			return { decision: "allow", reason: "read-only" };

		case "write_file": {
			if (isOutsideProjectDir(call.path, projectDir)) {
				return { decision: "deny", reason: `path is outside the project directory: ${call.path}` };
			}
			return { decision: "allow", reason: "reversible write inside the project directory" };
		}

		case "run_tests": {
			const cwd = call.options?.cwd;
			if (cwd !== undefined && isOutsideProjectDir(cwd, projectDir)) {
				return { decision: "deny", reason: `cwd is outside the project directory: ${cwd}` };
			}
			return { decision: "allow", reason: "test run inside the project directory" };
		}

		case "run_command": {
			if (isDangerousCommand(call.command)) {
				return { decision: "deny", reason: `command matches a denied dangerous pattern: ${call.command}` };
			}
			return { decision: "ask", reason: "arbitrary shell command is irreversible" };
		}

		case "delegate_task":
			// Read-only by construction: every subagent's tool set is a subset
			// of read-only tools (enforced in subagents/registry.ts), so running
			// one can't have side effects beyond what read_file/search_files do.
			return { decision: "allow", reason: "delegates to a registered subagent restricted to read-only tools" };

		case "update_plan":
			// No filesystem/subprocess side effect at all — just visibility
			// state for the UI.
			return { decision: "allow", reason: "plan tracking only, no side effects" };

		default:
			return assertNever(call);
	}
}

function isOutsideProjectDir(targetPath: string, projectDir: string): boolean {
	const resolvedProjectDir = resolve(projectDir);
	const resolvedTarget = resolve(resolvedProjectDir, targetPath);
	const rel = relative(resolvedProjectDir, resolvedTarget);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

// Pattern match, not a shell parser — good enough to catch the common forms
// of each named pattern without trying to fully parse arbitrary shell syntax.
function isDangerousCommand(command: string): boolean {
	const normalized = command.toLowerCase();

	if (/\bsudo\b/.test(normalized)) return true;

	if (/\brm\b/.test(normalized)) {
		const hasRecursiveFlag = /(^|\s)-[a-z]*r[a-z]*(\s|$)/.test(normalized) || /--recursive\b/.test(normalized);
		const hasForceFlag = /(^|\s)-[a-z]*f[a-z]*(\s|$)/.test(normalized) || /--force\b/.test(normalized);
		if (hasRecursiveFlag && hasForceFlag) return true;
	}

	if (/\bgit\s+push\b/.test(normalized)) {
		const hasForceFlag = /--force\b/.test(normalized) || /(^|\s)-f(\s|$)/.test(normalized);
		if (hasForceFlag) return true;
	}

	return false;
}

function assertNever(x: never): never {
	throw new Error(`checkPermission: unhandled tool call ${JSON.stringify(x)}`);
}
