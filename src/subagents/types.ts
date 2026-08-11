import type { ToolName } from "../agentRuntime.js";

export interface SubagentDefinition {
	name: string;
	// Written as a routing rule, not a vague label — specific enough that a
	// router (the orchestrator's model, picking from the delegate_task tool's
	// description, or a future automated router) could pick the right
	// subagent without human disambiguation. See registry.ts's "explorer"
	// entry for the pattern to follow when adding a new one.
	description: string;
	systemPrompt: string;
	// Always a subset of ALL_TOOLS's keys — see agentRuntime.ts. Every tool
	// listed here must already be classified read-only in permissions.ts;
	// runSubagent.ts relies on that and does no permission checking itself.
	tools: ToolName[];
	maxIterations: number;
}
