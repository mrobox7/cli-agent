export interface PlanStep {
	step: string;
	status: "pending" | "in_progress" | "completed";
}

export interface UpdatePlanResult {
	ok: boolean;
	steps: PlanStep[];
}

// Not really a tool in the same sense as the other five in src/tools/ — no
// filesystem/subprocess side effect. The model's `steps` argument is already
// validated against the Zod schema before this runs (see orchestrator.ts's
// `update_plan` tool definition); this just hands it back in the same
// `{ ok, ... }` shape every other tool returns, so it fits the existing
// tool-result pattern.
export function updatePlan(steps: PlanStep[]): UpdatePlanResult {
	return { ok: true, steps };
}
