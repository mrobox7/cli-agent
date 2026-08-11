import { createInterface } from "node:readline/promises";
import { tool, generateText, type JSONValue, type ModelMessage, type ToolResultPart, type ToolSet } from "ai";
import { z } from "zod";
import { checkPermission, type ToolCall } from "./permissions.js";
import { ALL_TOOLS, createPortkeyModel, executeToolCall as executeRealToolCall, stripReasoningParts, toToolCall as toRealToolCall } from "./agentRuntime.js";
import { DEFAULT_MODEL, type ModelKey } from "./models.js";
import { SUBAGENTS } from "./subagents/registry.js";
import { runSubagent } from "./subagents/runSubagent.js";
import { updatePlan, type PlanStep } from "./tools/updatePlan.js";

const MAX_ITERATIONS = 30;

const SYSTEM_PROMPT = [
	"You are a local coding agent with access to the current project directory.",
	"Prefer search_files over shelling out to grep/find via run_command.",
	"read_file and search_files are read-only and always allowed.",
	"write_file and run_tests are auto-allowed as long as the path stays inside the project directory.",
	"run_command is irreversible and requires human approval for every call — use it sparingly.",
	"For open-ended exploration (e.g. \"where is X defined\", \"which files reference Y\") prefer delegate_task over many manual read_file/search_files calls — it runs in an isolated context and returns just a summary, keeping your own context clean.",
	"For any task with more than one distinct step, call update_plan at the start to record your plan, and call it again whenever a step's status changes. Single-step tasks don't need it.",
].join(" ");

// Tools are defined WITHOUT `execute` on purpose: omitting it means the AI SDK
// returns the tool calls instead of auto-running them, so we can run each one
// through checkPermission() first.
//
// ALL_TOOLS (the five real, executable tools) comes from agentRuntime.ts —
// the same object subagents/runSubagent.ts builds its own restricted tool
// sets from. "delegate_task" is defined only here: it's a meta-tool the main
// orchestrator handles by dispatching to a subagent, not something any
// subagent could ever be given (it isn't part of ALL_TOOLS), which is what
// makes nested delegation structurally impossible rather than just refused.
const tools = {
	...ALL_TOOLS,
	delegate_task: tool({
		description: [
			"Delegate a task to a specialized subagent that runs its own isolated tool-call loop and returns only a summary — keeps your own context clean for open-ended work like broad exploration.",
			"Available subagents:",
			...SUBAGENTS.map((s) => `- "${s.name}": ${s.description}`),
		].join(" "),
		inputSchema: z.object({
			subagent: z.enum(SUBAGENTS.map((s) => s.name)).describe("Which registered subagent to delegate to."),
			task: z.string().describe("The task to hand off to the subagent, in natural language."),
		}),
	}),
	// Visibility only, not a gate: no filesystem/subprocess side effect, and
	// nothing in the loop requires a plan to exist before executing other
	// tools. See tools/updatePlan.ts.
	update_plan: tool({
		description:
			"Record or update your plan for a multi-step task, so progress is visible. Call at the start of any task with more than one distinct step, and again whenever a step's status changes. Not needed for single-step tasks.",
		inputSchema: z.object({
			steps: z.array(
				z.object({
					step: z.string(),
					status: z.enum(["pending", "in_progress", "completed"]),
				}),
			),
		}),
	}),
} satisfies ToolSet;

function toToolCall(toolName: string, input: unknown): ToolCall {
	if (toolName === "delegate_task") {
		const { subagent, task } = input as { subagent: string; task: string };
		return { tool: "delegate_task", subagent, task };
	}
	if (toolName === "update_plan") {
		const { steps } = input as { steps: PlanStep[] };
		return { tool: "update_plan", steps };
	}
	return toRealToolCall(toolName, input);
}

async function executeToolCall(
	call: ToolCall,
	modelKey: ModelKey,
	onEvent: (event: OrchestratorEvent) => void,
): Promise<unknown> {
	if (call.tool === "delegate_task") {
		const def = SUBAGENTS.find((s) => s.name === call.subagent);
		if (!def) {
			throw new Error(`delegate_task: unknown subagent "${call.subagent}"`);
		}
		onEvent({ type: "delegation-start", subagent: call.subagent, task: call.task });
		const summary = await runSubagent(def, call.task, modelKey);
		onEvent({ type: "delegation-end", subagent: call.subagent, summary });
		return { summary };
	}
	if (call.tool === "update_plan") {
		return updatePlan(call.steps);
	}
	return executeRealToolCall(call);
}

export interface OrchestratorResult {
	status: "completed" | "max_iterations";
	finalText: string;
	iterations: number;
	// Full message history after this call, including the task just run.
	// Pass this back in as `history` on the next call to continue the same
	// conversation (REPL-style) instead of starting a fresh one.
	messages: ModelMessage[];
}

// Progress-reporting events emitted during the loop. A UI (App.tsx, or the
// console fallback below) turns these into whatever it renders — the loop
// itself has no rendering logic.
export type OrchestratorEvent =
	| { type: "iteration-start"; iteration: number; maxIterations: number }
	| { type: "assistant-text"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	| { type: "tool-denied"; toolCallId: string; toolName: string; reason: string }
	| { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
	| { type: "delegation-start"; subagent: string; task: string }
	| { type: "delegation-end"; subagent: string; summary: string }
	| { type: "plan-updated"; steps: PlanStep[] }
	| { type: "done" }
	| { type: "max-iterations" };

export interface ApprovalRequest {
	toolCallId: string;
	toolName: string;
	input: unknown;
	reason: string;
}

export interface OrchestratorHandlers {
	onEvent: (event: OrchestratorEvent) => void;
	// Resolves to whether the human approved the irreversible call. Replaces
	// the previous direct readline.question() call in the loop — the UI
	// decides how to collect y/n (blocking terminal prompt, Ink keypress, etc).
	requestApproval: (request: ApprovalRequest) => Promise<boolean>;
}

export async function runOrchestrator(
	task: string,
	modelKey: ModelKey = DEFAULT_MODEL,
	handlers: OrchestratorHandlers,
	history: ModelMessage[] = [],
): Promise<OrchestratorResult> {
	const model = createPortkeyModel(modelKey);
	const { onEvent, requestApproval } = handlers;

	const messages: ModelMessage[] = [...history, { role: "user", content: task }];
	// Loop-local, not global or part of OrchestratorResult: visibility for
	// this one run only, reset each call. update_plan is a nudge, not a
	// gate — a task that never calls it just has an empty plan the whole
	// time, which is fine.
	let plan: PlanStep[] = [];

	for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
		onEvent({ type: "iteration-start", iteration, maxIterations: MAX_ITERATIONS });

		const result = await generateText({ model, system: SYSTEM_PROMPT, messages, tools });

		if (result.text) {
			onEvent({ type: "assistant-text", text: result.text });
		}

		// Strip reasoning parts before saving to history: @ai-sdk/openai-compatible
		// re-serializes them as `reasoning_content` on the next request, and Groq's
		// reasoning models (openai/gpt-oss-*) reject that field on inbound assistant
		// messages, breaking the 2nd turn of every tool-calling loop.
		messages.push(...stripReasoningParts(result.responseMessages));

		if (result.toolCalls.length === 0) {
			onEvent({ type: "done" });
			return { status: "completed", finalText: result.text, iterations: iteration, messages };
		}

		const resultParts: ToolResultPart[] = [];

		for (const call of result.toolCalls) {
			onEvent({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
			const toolCall = toToolCall(call.toolName, call.input);
			const permission = checkPermission(toolCall);

			if (permission.decision === "deny") {
				onEvent({
					type: "tool-denied",
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					reason: permission.reason,
				});
				resultParts.push({
					type: "tool-result",
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					output: { type: "execution-denied", reason: permission.reason },
				});
				continue;
			}

			if (permission.decision === "ask") {
				const approved = await requestApproval({
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					input: call.input,
					reason: permission.reason,
				});
				if (!approved) {
					onEvent({
						type: "tool-denied",
						toolCallId: call.toolCallId,
						toolName: call.toolName,
						reason: "user declined",
					});
					resultParts.push({
						type: "tool-result",
						toolCallId: call.toolCallId,
						toolName: call.toolName,
						output: { type: "execution-denied", reason: "user declined" },
					});
					continue;
				}
			}

			const output = await executeToolCall(toolCall, modelKey, onEvent);

			if (toolCall.tool === "update_plan") {
				plan = toolCall.steps;
				onEvent({ type: "plan-updated", steps: plan });
			}

			onEvent({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output });
			resultParts.push({
				type: "tool-result",
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				output: { type: "json", value: output as JSONValue },
			});
		}

		messages.push({ role: "tool", content: resultParts });
	}

	onEvent({ type: "max-iterations" });
	return { status: "max_iterations", finalText: "", iterations: MAX_ITERATIONS, messages };
}

function planMarker(status: PlanStep["status"]): string {
	switch (status) {
		case "completed":
			return "[x]";
		case "in_progress":
			return "[~]";
		case "pending":
			return "[ ]";
	}
}

// Console/readline handlers for running orchestrator.ts directly without the
// Ink UI (manual testing, `npx tsx src/orchestrator.ts "<task>"`). Mirrors
// the output format the loop used to print directly before it was made
// UI-agnostic.
function consoleHandlers(rl: ReturnType<typeof createInterface>): OrchestratorHandlers {
	return {
		onEvent(event) {
			switch (event.type) {
				case "iteration-start":
					console.log(`\n=== iteration ${event.iteration}/${event.maxIterations} ===`);
					break;
				case "assistant-text":
					console.log(`[assistant] ${event.text}`);
					break;
				case "tool-call":
					console.log(`[tool call] ${event.toolName}(${JSON.stringify(event.input)})`);
					break;
				case "tool-denied":
					console.log(`[denied] ${event.reason}`);
					break;
				case "tool-result":
					console.log("[result]", event.output);
					break;
				case "delegation-start":
					console.log(`[delegate → ${event.subagent}] ${event.task}`);
					break;
				case "delegation-end":
					console.log(`[delegate ← ${event.subagent}] ${event.summary}`);
					break;
				case "plan-updated":
					console.log(
						`[plan]\n${event.steps.map((s) => `  ${planMarker(s.status)} ${s.step}`).join("\n")}`,
					);
					break;
				case "done":
					console.log("[done] no further tool calls");
					break;
				case "max-iterations":
					console.log(`[stopped] hit the ${MAX_ITERATIONS}-iteration cap`);
					break;
			}
		},
		async requestApproval(request) {
			const answer = await rl.question(
				`[approval needed] ${request.reason}\n  ${request.toolName}(${JSON.stringify(request.input)})\n  Approve? (y/n) `,
			);
			return answer.trim().toLowerCase().startsWith("y");
		},
	};
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const task = process.argv.slice(2).join(" ");
	if (!task) {
		console.error('Usage: tsx src/orchestrator.ts "<task>"');
		process.exit(1);
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	runOrchestrator(task, DEFAULT_MODEL, consoleHandlers(rl))
		.catch((err) => {
			console.error(err);
			process.exit(1);
		})
		.finally(() => rl.close());
}
