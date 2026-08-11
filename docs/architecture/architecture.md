# Architecture

This is a prose summary of the two diagrams in this folder, distilled for cheap
agent/LLM context loading. The diagrams are the visual source of truth — open
them in a browser when you need exact layout, labels, or to update them.

- `local-execution-architecture.html` — v1 target: local-only execution.
- `local-execution-scaled-architecture.html` — future/scaled design: adds a
  multi-tenant cloud platform in front of the same local execution model, plus
  an optional sandboxed execution path.

## 1. Local Execution (v1 — what this repo currently targets)

Two machines:

**Cloud** — runs the "brain":
- **Context Engine** — repo map, code search.
- **Session Store** — history, checkpoints.
- **Orchestrator Agent** — plans, delegates, iterates. Calls out to a
  **Sub-agent** for isolated-context exploration (keeps the main loop's
  context clean).
- **Portkey** (was Vercel AI Gateway — switched 2026-08-04, Gateway has no
  free tier) — one endpoint in front of the configured provider integrations
  (currently just Groq), used for "plan + generate" calls. The two source
  diagrams in this folder still label this box "Vercel AI Gateway" and
  haven't been regenerated to match; treat this prose summary as current,
  the diagrams as stale on this one point.

**Local Machine** — runs the "hands":
- **Agent Panel** — the user-facing client. Sends the user's task to the
  Orchestrator.
- **Permission Scope Layer** — every tool call from the Orchestrator passes
  through here before executing. **This is the security boundary — there is
  no sandbox.** Classifies calls as read-only / reversible (auto-allow) or
  irreversible (needs human y/n).
- **Tools** (all plain functions, no LLM logic): `write_file`, `run_command`,
  `read_file`, `run_tests` → act on Filesystem / Terminal / Codebase.
- Errors/output flow back up to the Orchestrator, which iterates if a step
  failed, capped at ~30 iterations.

This maps directly onto `src/`: `orchestrator.ts` (the loop, which calls
Portkey directly via `@ai-sdk/openai-compatible` — no separate
provider-agnostic client file), `models.ts` (the model registry `--model`
selects from), `permissions.ts` (the scope layer), `tools/*.ts` (the five
tools), `ui/App.tsx` (renders the loop + y/n prompts — not yet wired up;
`index.tsx` currently calls the orchestrator directly instead).

## 2. Scaled Architecture (future direction, not yet built)

Same local execution model, but the cloud side becomes a real multi-tenant
platform:

- **API Gateway** — auth, per-user token limits.
- **Message Queue** — absorbs bursts of new session/background-task requests,
  decouples intake from orchestrator capacity.
- **Session Worker Pool** — consumes the queue, spins up an Orchestrator run
  per session.
- **Orchestrator** — now stateless and run as a **Vercel Workflow**: each
  loop iteration (call LLM → get tool call → execute → get result) is
  persisted as a durable step, so a crash on step 30 resumes at step 30
  instead of restarting. Talks to Redis (hot state) and Postgres (durable
  records) only through a Workflow SDK / Storage Service — never directly.
  Context scales up to ~1M tokens for long sessions.
- **Vercel AI Gateway** — failover + cost routing across providers; **Prompt
  Cache is called out as the single biggest cost lever**.
- **Storage Service** — conversation logs + snapshot index, backed by Blob
  Storage for checkpoints/snapshots.

**Guardrails Layer** (the scaled-up Permission Scope Layer) sits between the
cloud orchestrator and two possible execution targets:
- read-only tool calls → auto-allowed
- reversible tool calls → auto-allowed
- irreversible tool calls → human approval required

Two execution paths after the guardrails:
1. **Local execution** (Client Machine) — same as v1: Permission Scope Layer
   → Tools → Filesystem/Terminal. Called out explicitly: **"user IS the
   sandbox"** — there is still no process isolation here, the human approval
   step is the only safety net.
2. **Sandboxed execution** — a pre-warmed **Vercel Sandbox Pool** of
   microVMs, allocated by the orchestrator, with a **Checkpoint Layer**
   (shadow git) for snapshotting sandbox state.

## Key invariants to preserve when implementing

- The Permission Scope Layer has no LLM logic — it's a plain policy/gating
  function the orchestrator calls before every tool execution.
- Tools (`read_file`, `write_file`, `run_command`, `run_tests`) are plain
  functions with no LLM logic — classification of risk happens in the
  permission layer, not in the tools themselves.
- The orchestrator loop is stateless and capped at ~30 iterations per task.
- The LLM client is provider-agnostic; provider adapters are added only when
  their SDK is actually installed (none is installed yet).
- In local-only mode there is no sandbox — the Permission Scope Layer /
  human-approval gate on irreversible actions is the entire security
  boundary. Don't build features that assume sandbox-level isolation until
  the scaled architecture's sandboxed execution path is actually adopted.
