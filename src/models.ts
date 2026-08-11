// Registry of Groq models reachable through Portkey, selectable via `--model`
// or the interactive picker in index.tsx. `id` is the raw Groq model id;
// orchestrator.ts prefixes it with "@groq/" for Portkey's routing syntax.
// Labels reflect what was actually observed testing each model against this
// project's 5-tool loop, not vendor marketing claims — see PROGRESS.md.
export const MODELS = {
	"gpt-oss-120b": {
		id: "openai/gpt-oss-120b",
		label: "GPT-OSS 120B (strong reasoning; free-tier 8000 TPM limit hit easily)",
	},
	"gpt-oss-20b": {
		id: "openai/gpt-oss-20b",
		label: "GPT-OSS 20B (smaller/faster, but repeatedly hit tool_use_failed errors in testing)",
	},
	"qwen3.6-27b": {
		id: "qwen/qwen3.6-27b",
		label: "Qwen3.6 27B (default — zero observed tool-call failures across all testing this project)",
	},
} as const;

export type ModelKey = keyof typeof MODELS;

// qwen3.6-27b: the only model that never hit a tool_use_failed error across
// every test this project (main loop, REPL multi-turn, and subagent
// delegation) — see PROGRESS.md for the gpt-oss-20b/120b failure history
// that motivated switching the default to this.
export const DEFAULT_MODEL: ModelKey = "qwen3.6-27b";
