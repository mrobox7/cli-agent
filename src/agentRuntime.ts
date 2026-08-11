import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { MODELS, type ModelKey } from "./models.js";
import type { ToolCall } from "./permissions.js";
import { readFile } from "./tools/read_file.js";
import { writeFile } from "./tools/write_file.js";
import { runCommand } from "./tools/run_command.js";
import { runTests } from "./tools/run_tests.js";
import { searchFiles } from "./tools/search_files.js";

// Shared building blocks for any generateText()-based tool-call loop in this
// project. orchestrator.ts's main loop and subagents/runSubagent.ts both
// build on these instead of each keeping its own copy of the tool schemas,
// call-execution logic, or model resolution — which would risk the two
// drifting out of sync (e.g. a tool's schema changing in one loop but not
// the other).

// Portkey exposes an OpenAI-compatible REST API, so we reach it through the
// generic @ai-sdk/openai-compatible adapter rather than the portkey-ai
// vendor SDK — keeps generateText()/tool() from the `ai` package unchanged,
// same as when Vercel AI Gateway resolved the model string directly. Auth is
// via the `x-portkey-api-key` header (Portkey's own scheme, not a Bearer
// token), read from PORTKEY_API_KEY.
// Model syntax is Portkey's own: "@<integration-slug>/<model-name>", where
// "groq" is the slug for the Groq integration configured in the Portkey
// dashboard.
export function createPortkeyModel(modelKey: ModelKey) {
	const apiKey = process.env.PORTKEY_API_KEY;
	if (!apiKey) {
		throw new Error("PORTKEY_API_KEY is not set — required to call the model via Portkey.");
	}
	const portkey = createOpenAICompatible({
		name: "portkey",
		baseURL: "https://api.portkey.ai/v1",
		apiKey,
		headers: { "x-portkey-api-key": apiKey },
	});
	return portkey.chatModel(`@groq/${MODELS[modelKey].id}`);
}

// Tools are defined WITHOUT `execute` on purpose: omitting it means the AI SDK
// returns the tool calls instead of auto-running them, so callers can run each
// one through checkPermission() first (the main loop does this; subagents
// deliberately skip it — see runSubagent.ts for why that's safe).
//
// This is the single source of truth for real, executable tools. A
// subagent's tool set (subagents/types.ts's SubagentDefinition.tools) is
// always a subset of these keys — a subagent can never be given a tool that
// doesn't exist here, by construction. Notably, "delegate_task" is NOT one
// of these: it's a meta-tool defined only in orchestrator.ts, so it's
// structurally impossible for it to end up in a subagent's tool set.
export const ALL_TOOLS = {
	read_file: tool({
		description: "Read the contents of a file at the given path.",
		inputSchema: z.object({
			path: z.string().describe("Path to the file to read."),
		}),
	}),
	search_files: tool({
		description: "Search file contents for a pattern, like grep. Prefer this over run_command for finding code.",
		inputSchema: z.object({
			pattern: z.string().describe("Regex (or literal, with literal: true) pattern to search for."),
			path: z.string().optional().describe("File or directory to search. Defaults to the current directory."),
			ignoreCase: z.boolean().optional(),
			literal: z.boolean().optional().describe("Treat pattern as a literal string instead of a regex."),
			globPattern: z.string().optional().describe("Only search files matching this glob, e.g. \"*.ts\"."),
		}),
	}),
	write_file: tool({
		description: "Write content to a file, creating parent directories as needed.",
		inputSchema: z.object({
			path: z.string(),
			content: z.string(),
		}),
	}),
	run_tests: tool({
		description: "Run the project's test suite. Defaults to `npm test`.",
		inputSchema: z.object({
			command: z.string().optional().describe("Override the default test command."),
			cwd: z.string().optional(),
		}),
	}),
	run_command: tool({
		description: "Run an arbitrary shell command. Irreversible — requires human approval.",
		inputSchema: z.object({
			command: z.string(),
			cwd: z.string().optional(),
		}),
	}),
} satisfies ToolSet;

export type ToolName = keyof typeof ALL_TOOLS;

export function toToolCall(toolName: string, input: unknown): ToolCall {
	const args = input as Record<string, unknown>;
	switch (toolName) {
		case "read_file":
			return { tool: "read_file", path: args.path as string };
		case "search_files": {
			const { pattern, ...options } = args as { pattern: string; [key: string]: unknown };
			return { tool: "search_files", pattern, options };
		}
		case "write_file":
			return { tool: "write_file", path: args.path as string, content: args.content as string };
		case "run_tests":
			return { tool: "run_tests", options: args };
		case "run_command": {
			const { command, ...options } = args as { command: string; [key: string]: unknown };
			return { tool: "run_command", command, options };
		}
		default:
			throw new Error(`Unknown tool call: ${toolName}`);
	}
}

export async function executeToolCall(call: ToolCall): Promise<unknown> {
	switch (call.tool) {
		case "read_file":
			return readFile(call.path);
		case "search_files":
			return searchFiles(call.pattern, call.options);
		case "write_file":
			return writeFile(call.path, call.content);
		case "run_tests":
			return runTests(call.options);
		case "run_command":
			return runCommand(call.command, call.options);
		case "delegate_task":
			// Delegation needs the subagent registry, a model, and event
			// reporting — none of which this shared/generic executor has.
			// orchestrator.ts intercepts "delegate_task" before it reaches
			// here, and a subagent can never produce this call in the first
			// place ("delegate_task" isn't in ALL_TOOLS for a subagent to be
			// given). Reaching this line would mean a bug upstream.
			throw new Error('"delegate_task" must be handled by the orchestrator, not the shared tool executor.');
		case "update_plan":
			// Same reasoning as "delegate_task" above: orchestrator.ts owns the
			// loop-local plan state and the plan-updated event, and intercepts
			// this before it ever reaches here.
			throw new Error('"update_plan" must be handled by the orchestrator, not the shared tool executor.');
	}
}

// Strips `reasoning` message parts before they're saved to history:
// @ai-sdk/openai-compatible re-serializes them as `reasoning_content` on the
// next request, and Groq's reasoning models (openai/gpt-oss-*) reject that
// field on inbound assistant messages, breaking the 2nd turn of every
// tool-calling loop. Both the main loop and subagent loops hit this the same
// way, so it's shared here rather than copy-pasted.
export function stripReasoningParts(messages: ModelMessage[]): ModelMessage[] {
	return messages.map((message) =>
		message.role === "assistant" && Array.isArray(message.content)
			? { ...message, content: message.content.filter((part) => part.type !== "reasoning") }
			: message,
	);
}
