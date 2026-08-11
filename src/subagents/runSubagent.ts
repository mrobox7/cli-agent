import { generateText, type JSONValue, type ModelMessage, type ToolResultPart, type ToolSet } from "ai";
import type { ModelKey } from "../models.js";
import { ALL_TOOLS, createPortkeyModel, executeToolCall, stripReasoningParts, toToolCall } from "../agentRuntime.js";
import type { SubagentDefinition } from "./types.js";

// A subagent's own tool-call loop: its own generateText calls, its own
// message history (never shares or sees the main orchestrator's
// conversation), and its own iteration cap (def.maxIterations, independent
// of the main loop's MAX_ITERATIONS) — so its exploration doesn't bloat the
// caller's context, and a runaway subagent can't consume the main loop's
// iteration budget.
//
// Deliberately has NO checkPermission() call anywhere in here. That's safe
// only because every tool a SubagentDefinition can list is required to
// already be classified read-only in permissions.ts (today: read_file,
// search_files) — restricting a subagent to a tool subset by simple
// omission is exactly what makes that omission a real security boundary
// instead of a suggestion. If a subagent definition is ever given a
// non-read-only tool (write_file, run_command, run_tests), this loop would
// execute it with no approval gate at all — don't do that without adding
// permission checking here too.
export async function runSubagent(def: SubagentDefinition, task: string, modelKey: ModelKey): Promise<string> {
	const model = createPortkeyModel(modelKey);
	const subagentTools: ToolSet = Object.fromEntries(def.tools.map((name) => [name, ALL_TOOLS[name]]));

	const messages: ModelMessage[] = [{ role: "user", content: task }];

	for (let iteration = 1; iteration <= def.maxIterations; iteration++) {
		const result = await generateText({ model, system: def.systemPrompt, messages, tools: subagentTools });

		messages.push(...stripReasoningParts(result.responseMessages));

		if (result.toolCalls.length === 0) {
			return result.text;
		}

		const resultParts: ToolResultPart[] = [];
		for (const call of result.toolCalls) {
			const toolCall = toToolCall(call.toolName, call.input);
			const output = await executeToolCall(toolCall);
			resultParts.push({
				type: "tool-result",
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				output: { type: "json", value: output as JSONValue },
			});
		}
		messages.push({ role: "tool", content: resultParts });
	}

	return `(subagent "${def.name}" hit its ${def.maxIterations}-iteration cap without finishing)`;
}
