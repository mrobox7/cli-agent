# AGENTS.md

Instructions for any coding agent (Claude Code or otherwise) working in this
repository.

## What this is

`cli-agent` — a local CLI coding agent: natural-language task → LLM tool-call
loop → permission-gated execution. Ink/React terminal UI, Commander for CLI
parsing, TypeScript, run via `tsx`.

Start every session by reading **[PROGRESS.md](./PROGRESS.md)** — it tracks
what's implemented, what's still a stub, and what to work on next. Update it
whenever you finish a unit of work or make a decision that changes the plan.

## Architecture

Full diagrams and a distilled summary live in
**[docs/architecture/architecture.md](./docs/architecture/architecture.md)**.
Read that before touching `orchestrator.ts` or `permissions.ts` — it explains
*why* the module boundaries are drawn where they are, not just what's in each
file.

The short version:

```
task ─▶ orchestrator loop (per-turn, ~30 iter cap)
          ├─▶ generateText() via Portkey (ai package + @ai-sdk/openai-compatible,
          │     no vendor SDK) → gets a tool call back
          ├─▶ permissions.ts   classifies the tool call: read-only/reversible
          │                    (auto-allow) vs irreversible (human y/n)
          ├─▶ tools/*.ts     plain functions, no LLM logic, execute the call
          ├─▶ delegate_task  hands a task to a registered subagent
          │                  (subagents/runSubagent.ts) — its own isolated
          │                  tool-call loop, restricted to read-only tools,
          │                  returns only a summary
          └─▶ update_plan    records/updates a loop-local plan (visibility
                             only, not a gate) → emits a plan-updated event
        result fed back into conversation state, loop continues or turn ends
ui/App.tsx renders each step live via OrchestratorHandlers (onEvent /
requestApproval — orchestrator.ts has no console.log/readline of its own
anymore) and runs as a persistent REPL: after a turn ends it prompts for the
next task, carrying conversation history forward, until /exit or /quit.
```

There is no separate `llm.ts` provider abstraction — the LLM call is built
by `agentRuntime.ts`'s `createPortkeyModel()` (routing through Groq) and
used by both `orchestrator.ts`'s main loop and `subagents/runSubagent.ts`.
Switching models is just changing the `--model` flag / `src/models.ts`
entry, no adapter layer needed. (Originally this went through Vercel AI
Gateway; switched to Portkey 2026-08-04 because Gateway has no free tier —
see PROGRESS.md for the full history and the models actually tested.)

`agentRuntime.ts` is the shared foundation for *any* `generateText()`-based
tool-call loop in this project — `createPortkeyModel`, the real tools'
`ALL_TOOLS` definitions, `toToolCall`/`executeToolCall`, and
`stripReasoningParts` all live there so the main loop and subagent loops
can't drift out of sync with two copies of the same schemas. `delegate_task`
itself is defined only in `orchestrator.ts`, layered on top of
`ALL_TOOLS` — it is deliberately *not* part of `ALL_TOOLS`, which is what
makes it structurally impossible for a subagent to ever be given the
ability to delegate further (see `src/subagents/`, below).

## Conventions

- **Tools are plain functions.** No LLM logic, no permission logic, inside
  `src/tools/*.ts`. They take arguments, do the thing, return a result or
  error.
- **Finding/reading code goes through `search_files.ts` + `read_file.ts`,
  not `run_command`.** `search_files.ts` shells out to the system `grep`
  (via `execFile` with an args array — never build a shell string from an
  LLM-supplied pattern/path) and is meant to be classified read-only just
  like `read_file`. Keep search and arbitrary shell execution as separate
  tools, same as Claude Code separates Grep from Bash, so the permission
  layer doesn't have to prompt a human for read-only lookups.
- **`permissions.ts` is a pure policy/gating layer.** No LLM logic. One check
  function the orchestrator calls before every tool execution. Classify by
  risk: read-only → auto-allow, reversible (e.g. writing a tracked file) →
  auto-allow, irreversible (e.g. `run_command`) → always requires explicit
  human approval via the UI.
- **There is no sandbox in the local-execution model.** The Permission Scope
  Layer / human-approval gate on irreversible actions is the entire security
  boundary. Don't write code that assumes process isolation.
- **The orchestrator is stateless per call and capped at ~30 iterations**
  per task. Multi-turn/REPL use works by the *caller* (`App.tsx`) holding
  conversation history and passing it back in explicitly via
  `runOrchestrator`'s `history` param — not by the orchestrator keeping any
  state of its own between calls. Don't add hidden state between calls
  beyond that explicitly-passed history.
- **LLM calls go through Portkey (the `ai` package + `@ai-sdk/openai-compatible`),
  not a vendor SDK.** Portkey exposes an OpenAI-compatible REST API
  (`https://api.portkey.ai/v1`), so `orchestrator.ts` reaches it through the
  generic `@ai-sdk/openai-compatible` adapter rather than the `portkey-ai`
  npm package — `generateText()`/`tool()` stay exactly as they'd be with any
  other `ai`-package provider. Model ids use Portkey's `"@<slug>/<model-id>"`
  syntax (`groq` is the configured integration slug). Auth via
  `PORTKEY_API_KEY`, sent as the `x-portkey-api-key` header (Portkey's own
  auth scheme, not a Bearer token). This is what gives provider-agnosticism,
  instead of a hand-written `llm.ts` adapter layer.
- **`@ai-sdk/openai-compatible` has a known bug worth knowing about**: it
  echoes back any `reasoning` message part as a `reasoning_content` field on
  the next outgoing request, which Groq's reasoning models
  (`openai/gpt-oss-*`) reject. `agentRuntime.ts`'s `stripReasoningParts()`
  works around this by stripping `reasoning` parts out of a turn's
  `responseMessages` before they're pushed onto history — both
  `orchestrator.ts` and `subagents/runSubagent.ts` call it after every
  `generateText()`. Don't remove that call from either loop without
  re-verifying multi-turn tool calls against a `gpt-oss` model — see
  PROGRESS.md for the failure mode.
- **Tool definitions passed to the AI SDK have no `execute` function.**
  Omitting it is what makes `generateText` return `toolCalls` instead of
  auto-running them — required so every call can go through
  `checkPermission()` first (or, for a subagent, so `runSubagent.ts` can run
  it directly — see below for why that's safe without a permission check).
  Don't add `execute` to any `tool()` definition in `agentRuntime.ts` or
  `orchestrator.ts`; execution happens manually in each loop instead.
- **Subagents are generic and registry-based (`src/subagents/`) — adding
  one should only ever require an entry in `registry.ts`.** A
  `SubagentDefinition` (`types.ts`) lists a subset of `agentRuntime.ts`'s
  `ToolName`s it's allowed to use; `runSubagent.ts` builds that subagent's
  actual tool set from `ALL_TOOLS` generically, and has **no
  `checkPermission()` call at all** — that omission is only safe because
  every tool a subagent can be given is required to already be classified
  read-only in `permissions.ts`. Don't add a non-read-only tool
  (`write_file`, `run_command`, `run_tests`) to any subagent's `tools`
  without also adding permission checking to `runSubagent.ts`. The
  no-nested-delegation guarantee (a subagent can never itself call
  `delegate_task`) is enforced twice: structurally, since `delegate_task`
  isn't part of `ALL_TOOLS` for `ToolName` to include it in the first
  place, and at runtime, via an assertion in `registry.ts` that throws on
  module load if any entry's `tools` somehow contains it anyway.
- **`update_plan` is visibility, not a gate.** It records/updates a
  `PlanStep[]` (`tools/updatePlan.ts`) as loop-local state inside
  `runOrchestrator` — not global, not persisted in `OrchestratorResult`,
  reset every call/turn. Nothing else in the loop checks whether a plan
  exists or blocks on it; a task that never calls `update_plan` behaves
  exactly the same as before this tool existed. Every call emits a
  `"plan-updated"` event (the full `steps` array) that `App.tsx` renders as
  a separate persistent checklist, not a line in the scrolling log — don't
  route it through `formatEvent`/the log the way other events are, that's
  intentional. The system prompt is what actually gets the model to call
  it (a schema existing isn't enough on its own) — don't remove that line
  without expecting `update_plan` to go unused.
- Every `src/*.ts` file currently starts with a `TODO:` comment block
  describing its intended responsibilities — read it before implementing,
  and remove it once the file is actually implemented (don't leave stale TODO
  scaffolding next to real code).

## Workflow

- Typecheck with `npm run typecheck` (`tsc --noEmit`) before considering a
  change done.
- Run the CLI locally with `npm run dev` (`tsx src/index.tsx`).
- This is a git repository (no commits yet as of this writing). `git init`
  wasn't run by an agent session — don't run destructive git commands
  without checking with the user first.
- Keep `PROGRESS.md` current: what's done, what's in flight, open decisions.
  Treat it as the handoff note to the next agent session, not a changelog.
