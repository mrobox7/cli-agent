import type { SubagentDefinition } from "./types.js";

// Registry of subagents delegate_task (orchestrator.ts) can hand a task to.
// Adding a new one should only ever require adding an entry here — nothing
// else in the codebase should need to change (orchestrator.ts builds its
// delegate_task tool's schema/description from this array, and
// runSubagent.ts builds each run's tool set from `tools` generically).
export const SUBAGENTS: SubagentDefinition[] = [
	{
		name: "explorer",
		description:
			'Read-only codebase exploration: locating where something is defined, finding files by name/pattern, tracing which files reference a symbol, or answering "where is X" / "which files call Y" when the exact path isn\'t known yet. Cannot write files or run commands — for anything beyond looking, use write_file/run_command/run_tests directly instead of delegating. Prefer this over several manual read_file/search_files calls when the search space is broad or the target location is unknown.',
		systemPrompt:
			"You are a read-only codebase exploration subagent. You only have read_file and search_files available — you cannot write files, run commands, or run tests; those tools do not exist for you, by design, so don't claim you performed one or suggest you're about to. Investigate the task, then report a concise summary: relevant file paths, short excerpts, and a direct answer to what was asked. Don't pad the answer with anything not needed to answer the task.",
		tools: ["read_file", "search_files"],
		maxIterations: 10,
	},
];

// No-nested-delegation guarantee, enforced in code, not just by convention:
// a subagent must never be handed "delegate_task" as one of its own tools,
// or it could spawn subagents of its own with no bound on depth.
// TypeScript already makes this impossible to express for a well-typed
// SubagentDefinition ("delegate_task" isn't a member of ToolName, since
// ALL_TOOLS in agentRuntime.ts never defines it), but this is a runtime
// safety net in case a future entry's `tools` array is ever built
// dynamically (e.g. loaded from config) instead of written as a literal,
// which would bypass that compile-time guarantee.
for (const def of SUBAGENTS) {
	if ((def.tools as string[]).includes("delegate_task")) {
		throw new Error(
			`Subagent "${def.name}" lists "delegate_task" in its own tools — nested delegation is not allowed.`,
		);
	}
}
