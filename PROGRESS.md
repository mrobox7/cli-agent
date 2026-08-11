# Progress

Last updated: 2026-08-08 (added a plan-tracking tool, update_plan — visibility only, not a gate — with a persistent checklist in App.tsx)

Read this first. It's the handoff note for whichever agent picks this up
next — what's actually done, what's stubbed, and what to do next. Keep it
current as you work; this is not a changelog, overwrite stale sections rather
than appending to them.

## Status: end-to-end functional (local execution model)

All five layers described in `docs/architecture/architecture.md` §1 are
implemented and wired together: `index.tsx` → `App.tsx` (Ink UI) →
`orchestrator.ts` (loop, via Portkey/Groq) → `permissions.ts` → `tools/*.ts`.
Verified live end-to-end, including the interactive y/n approval prompt
rendered by Ink (not readline) — see the orchestrator.ts and App.tsx notes
below for exactly what was tested. Rough edges remain (see "Not started" and
"Open decisions" below) but there's no stub-only file left in the core loop.

### Done
- Project skeleton: `package.json`, `tsconfig.json`, dependencies installed
  (`commander`, `ink`, `react`, `tsx`, `typescript`, plus
  `@ai-sdk/openai-compatible`, `@inquirer/prompts`, `ink-text-input` added
  along the way — see the Portkey and REPL notes below for why each was
  added).
- `bin`/`dev` script wired: `npm run dev` runs `src/index.tsx` via `tsx`.
- **`src/index.tsx` — real CLI entry point**: `cli-agent ["<task>"] [--model
  <key>]`, via Commander. The task argument is now **optional** (was
  required) — see the REPL note below. `--model` picks a key from
  `src/models.ts`; an unknown key warns and falls through to the picker
  path. No flag + running in a TTY → interactive picker (`@inquirer/prompts`'s
  `select`, listing every `MODELS` entry with its label). No flag + non-TTY
  (piped/CI) → silently uses `DEFAULT_MODEL`, no prompt. Renders
  `<App initialTask={task} model={modelKey} onExit={...} />` via Ink's
  `render()`, awaits `waitUntilExit()`, then `process.exit`s with the code
  `App` reported via `onExit`.
  - **Bug found and fixed (2026-08-04): the REPL exited immediately after
    going through the interactive model picker, with no way to type
    anything** — reproduced live by the user, then root-caused via a
    diagnostic script: `@inquirer/prompts`'s `select()` uses a Node
    `readline` interface internally (`@inquirer/core`'s `create-prompt.js`)
    and calls `rl.close()` on resolve; that leaves `process.stdin` in a
    **paused** state (confirmed: `process.stdin.isPaused()` was `true`
    right after `select()` resolved, with a stray leftover `data`
    listener). Ink's own raw-mode input (`stdin.ref()` + a `'readable'`
    listener, see `node_modules/ink/build/components/App.js`) apparently
    doesn't recover from that on its own — the process would render once
    and exit(0) shortly after, without the user ever typing `/exit`. Did
    **not** reproduce when `--model` was passed (skipping the picker
    entirely) — isolating the picker/readline handoff as the cause, not
    something in `App.tsx`'s own REPL logic. **Fix**: call
    `process.stdin.resume()` in `index.tsx` right after `resolveModel()`
    returns and before `render()` — a single line, standard fix for this
    known class of readline-prompt-library + Ink interaction issue.
    Verified fixed live under a pty: full flow through the picker → typed
    task → response → `/exit` → clean exit (code 0). If this regresses
    again after future changes near `resolveModel()`/the picker, check
    `process.stdin.isPaused()` right before `render()` first.
- **`src/ui/App.tsx` — real Ink UI, REPL-style (rewritten 2026-08-04)**. No
  longer a placeholder, and no longer single-shot (see history below).
  Structure:
  - If `initialTask` is given, runs it immediately on mount; otherwise opens
    straight into the input prompt. After **every** turn (success or
    error), the app returns to the prompt instead of exiting — it only
    exits on an explicit `/exit` or `/quit` typed at the prompt (or
    Ctrl+C). Conversation history (`ModelMessage[]`) is kept in a
    `useRef` across turns and threaded through `runOrchestrator`'s new
    `history` param (see orchestrator.ts note below) — each turn continues
    the same conversation rather than starting fresh. **Verified live**:
    told it "my name is Bob" as the initial task, then typed a *separate*
    follow-up turn "what is my name?" at the prompt — it correctly answered
    "Your name is Bob", confirming history actually threads across turns
    and isn't just an artifact of a single call. `/exit` confirmed to
    produce a clean process exit (code 0), not a timeout/kill.
  - Errors from a turn (e.g. a model tool-call failure) are caught, logged
    as `[error] ...`, and the app returns to the prompt rather than
    crashing the whole session — a bad turn (a real, observed failure mode
    for some models, see orchestrator.ts notes below) shouldn't kill a
    persistent session the way it would a one-shot run.
  - Input is collected via `ink-text-input` (new dependency) — a normal
    typed line with visible cursor and backspace, not raw single-keypress
    handling. The approval prompt is unaffected by this: it still renders
    only during a running turn (mutually exclusive with the input prompt
    by construction) and still resolves on a raw `y`/`n` keypress via
    `useInput`, same as before this rewrite.
  - `onEvent` turns each `OrchestratorEvent` into a log-line string
    (`formatEvent`) appended to a `logEntries` state array, rendered via
    Ink's `<Static>` (append-only, so Ink doesn't re-render already-printed
    lines — the right primitive for a growing log). The `"done"` event is
    now suppressed in `formatEvent` since each turn already ends with one
    consolidated `[status] finalText` summary line printed by `runTurn`.
  - **Bug found and fixed while building the original (pre-REPL) single-shot
    version**: calling Ink's `exit()` in the same `.then()` callback as
    `setResult()` tore the app down before React had committed/flushed that
    state update, so the final log line and summary never actually reached
    the terminal (confirmed via a raw pty capture — those substrings were
    bytes-absent from the output, not just visually clobbered by Ink's
    redraw). Fixed by moving the `exit()` call into its own `useEffect`
    keyed on the relevant state. The REPL rewrite's `phase === "exiting"`
    effect follows the same pattern — don't collapse it back into an event
    handler.
  - **Verified live** via a raw pty (Python's `pty` module — plain piped
    stdin doesn't give Ink a real TTY for raw-mode keypress input, and a
    naive `script`+FIFO combo didn't reliably deliver a timed keystroke
    either): full `run_command` flow (tool call → approval prompt →
    keypress → execution → result → summary → prompt returns) and the
    multi-turn history/`/exit` flow described above. Also reverified the
    no-tool-call path and the standalone `orchestrator.ts` CLI entry point
    (unaffected by this rewrite — still single-shot, see below) still work.
- **`src/models.ts` — model registry, new file**. `MODELS` maps a short key
  (e.g. `"gpt-oss-120b"`) to `{ id, label }`, where `id` is the raw Groq
  model id and `label` reflects what was actually observed testing each
  model against this project's 5-tool loop (not vendor claims — see the
  Portkey section below for the testing that produced these labels).
  `DEFAULT_MODEL` is `"gpt-oss-20b"` (changed from `"gpt-oss-120b"`
  2026-08-04, by explicit request — likely to sidestep the 120b model's
  8000 TPM free-tier ceiling noted below). Currently only 3 of the 5 Groq
  models
  tried are registered (`gpt-oss-120b`, `gpt-oss-20b`, `qwen3.6-27b`) — by
  explicit request, not because the other two don't work; see the Portkey
  notes for why `llama-3.3-70b-versatile` was excluded (fails tool calls
  outright) and where `llama-3.1-8b-instant` stands (the most reliable one
  tested, just not currently in the registry).
- Architecture decided and documented: see
  [docs/architecture/architecture.md](./docs/architecture/architecture.md)
  and the two source diagrams in `docs/architecture/`.
- `AGENTS.md` / `CLAUDE.md` / this file set up.
- **`src/tools/*.ts` — six tools implemented**, plain functions, no
  LLM/permission logic inside them:
  - `search_files.ts` — `searchFiles(pattern, { path?, ignoreCase?,
    literal?, globPattern?, maxResults? })` → `{ ok, matches, truncated,
    error? }`. Shells out to the system `grep` (`ugrep` on this host, GNU
    grep-compatible) via `execFile` with an args array (no shell string
    interpolation, so the pattern/path can't inject commands). Excludes
    `.git`/`node_modules`/`dist`/`build` by default. grep exit code 1 (no
    matches) is treated as success with an empty result, not an error. This
    is the tool the LLM should reach for instead of shelling out to grep via
    `run_command` — it's meant to be classified read-only/auto-allow once
    `permissions.ts` exists, same as Claude Code's Grep tool being separate
    from Bash.
  - `read_file.ts` — `readFile(path)` → `{ ok, content? , error? }`.
  - `write_file.ts` — `writeFile(path, content)` → `{ ok, error? }`;
    creates parent directories recursively before writing.
  - `run_command.ts` — `runCommand(command, { cwd?, timeoutMs? })` →
    `{ exitCode, stdout, stderr }`. 120s default timeout, 10MB output cap,
    never throws (errors surface as a non-zero `exitCode`).
  - `run_tests.ts` — `runTests({ command?, cwd?, timeoutMs? })` →
    `{ passed, exitCode, stdout, stderr }`. Defaults to `npm test`; a custom
    `command` is the "arbitrary/parameterized invocation" case the
    Permission Scope Layer should treat as irreversible, per the original
    TODO comment (not yet enforced — permissions.ts doesn't exist yet).
  - Manually smoke-tested (nested-dir write, missing-file read error,
    non-zero exit code with stdout/stderr, pass/fail via `true`/`false`) —
    no automated test suite exists yet for this repo itself.
  - **`updatePlan.ts` (new, 2026-08-08)** — `updatePlan(steps: PlanStep[])`
    → `{ ok: true, steps }`. Not really a tool in the same sense as the
    other five: no filesystem/subprocess side effect at all, it's pure
    plan-tracking state. `PlanStep = { step: string; status: "pending" |
    "in_progress" | "completed" }`, exported from here and reused by
    `permissions.ts` (the `ToolCall` variant), `orchestrator.ts` (the
    loop-local `plan` state and `plan-updated` event), and `App.tsx` (the
    checklist UI) — one source of truth for the shape.
- **`src/permissions.ts` — `checkPermission(call: ToolCall, projectDir?)`
  implemented**, plain function, no LLM logic. **Now wired into
  `orchestrator.ts`** (was built and tested standalone first, by request;
  the wiring happened when `orchestrator.ts` was written):
  - `ToolCall` is a discriminated union, originally over the five real tools
    (`read_file`, `search_files`, `write_file`, `run_tests`, `run_command`),
    reusing each tool's own `Options` type so there's one source of truth
    for argument shapes. Since extended with `delegate_task` (2026-08-07)
    and `update_plan` (2026-08-08) — see the subagents and plan-tracking
    notes below for those two.
  - Returns `{ decision: "allow" | "deny" | "ask", reason }`.
  - `read_file` / `search_files` / `update_plan` → always `allow`
    (`update_plan` has no filesystem/subprocess side effect at all).
  - `write_file` → `allow` unless `path` resolves outside `projectDir`, then
    `deny`. `run_tests` → same check against `options.cwd` (no `cwd` =
    allow). Path check is done via `path.resolve`/`relative`, not string
    prefix matching, so it isn't fooled by lookalike sibling dirs.
  - `run_command` → `deny` if the command matches a dangerous pattern
    (`sudo` anywhere; `rm` combined with a recursive+force flag in any
    order/spacing, e.g. `-rf`/`-fr`/`-r -f`; `git push` with `--force` or
    `-f`), otherwise `ask` (never auto-allow — irreversible by default).
  - **Still not enforced**: `run_tests.ts`'s own doc comment says a custom
    `command` override should be treated as irreversible/`ask`, but
    `checkPermission` only checks `cwd` for `run_tests`, per the literal
    spec it was built to. `orchestrator.ts` inherits this gap as-is —
    revisit if it matters in practice.
  - Smoke-tested standalone with 17 cases covering every branch (all passed)
    before it was wired in.
- **`src/orchestrator.ts` — the main agent loop, implemented**:
  - **Routing switched from Vercel AI Gateway to Portkey (2026-08-04)** —
    Vercel AI Gateway has no free tier; Portkey does, and the user already
    had Groq wired up as an integration there. Still no vendor SDK: Portkey
    exposes an OpenAI-compatible REST API, so `orchestrator.ts` reaches it
    through the generic `@ai-sdk/openai-compatible` adapter
    (`createOpenAICompatible({ baseURL: "https://api.portkey.ai/v1", headers:
    { "x-portkey-api-key": ... } })`), not the `portkey-ai` vendor package —
    `generateText()`/`tool()` from the `ai` package are unchanged from the
    Gateway version, only how the model is constructed changed.
    - Auth is `PORTKEY_API_KEY` (renamed from the old `AI_GATEWAY_API_KEY`
      env var — it's a different service, keeping the old name would have
      been misleading). `runOrchestrator` throws immediately if unset,
      before touching the network.
    - Model id syntax is Portkey's own: `"@<integration-slug>/<model-id>"`
      — `groq` is the slug for the Groq integration in the Portkey
      dashboard. `createPortkeyModel(modelKey)` builds this from
      `MODELS[modelKey].id` (see `src/models.ts`).
    - **Known adapter bug, worked around**: `@ai-sdk/openai-compatible`
      unconditionally re-serializes any `reasoning` part in an assistant
      message as `reasoning_content` on the *next* outgoing request (source:
      `node_modules/@ai-sdk/openai-compatible/dist/index.js` ~line 272, no
      provider option to disable it). Groq's reasoning models
      (`openai/gpt-oss-*`) reject that field on inbound assistant messages,
      which broke turn 2 of every tool-calling loop that used a reasoning
      model. Fixed in `runOrchestrator` by filtering `type === "reasoning"`
      parts out of `result.responseMessages` before pushing them onto
      `messages` — we don't need the model to see its own past reasoning
      text anyway. Confirmed fixed: multiple clean multi-turn runs against
      `openai/gpt-oss-120b` afterward with no recurrence.
    - **Model reliability findings** (task: "list the files in this
      directory", all 5 tools in the schema), from live testing this
      session:
      - `llama-3.3-70b-versatile` — fails immediately, every time
        (`tool_use_failed`, un-callable with this 5-tool schema on this
        account). Not in `MODELS`.
      - `llama-3.1-8b-instant` — the only model that went multiple tool-call
        turns cleanly on every attempt. Weaker reasoning (hallucinated an
        absolute path once, mishandled a directory read once). Not
        currently in `MODELS` by explicit request, despite being the most
        reliable one tested — worth reconsidering if `gpt-oss`/`qwen`
        prove flaky in practice.
      - `openai/gpt-oss-120b` — reasoning_content bug above was the main
        blocker, now fixed. Separately, this account's Groq free tier caps
        it at **8000 tokens/minute**, which is easy to blow past: a
        `search_files` call with an unspecific pattern (e.g. `"."` matches
        almost every non-empty line) can return up to `maxResults` (200 by
        default, see `search_files.ts`) matches, ~7500 tokens of JSON on its
        own. Also occasionally omits a required tool argument outright
        (sampling variance, not reproduced consistently). Was
        `DEFAULT_MODEL` initially by explicit request; changed to
        `gpt-oss-20b` shortly after (also explicit request), likely to
        dodge this model's TPM ceiling.
      - `openai/gpt-oss-20b` — same reasoning_content bug, now fixed by the
        same code change. Still `DEFAULT_MODEL` as of this writing, but
        **the multi-turn concern flagged above has since materialized**: a
        live run (`"list the files in this directory"`) hit the exact same
        `tool_use_failed: missing properties: 'pattern'` schema error that
        `gpt-oss-120b` hit earlier, on iteration 2, after a `search_files`
        call with an empty/catch-all pattern returned a very large result.
        So both `gpt-oss` sizes have now shown this failure mode in real
        multi-turn use, not just `gpt-oss-120b`. Worth revisiting as
        `DEFAULT_MODEL` — see the open decision on `llama-3.1-8b-instant`
        below, which has never shown this failure in any test this session.
      - `qwen/qwen3.6-27b` — clean multi-turn run in testing (called
        `run_command` correctly, got approval, finished with no errors); a
        separate later multi-turn REPL session (two turns, `"my name is
        Bob"` then a follow-up `"what is my name?"`) also completed cleanly
        with correct history recall both times. The most-tested model this
        session without a single observed failure, including through the
        subagent delegation flow below (2026-08-07) — worth switching
        `DEFAULT_MODEL` to this over `gpt-oss-20b` at some point; see the
        open decision below, unchanged.
      - `openai/gpt-oss-20b` (still `DEFAULT_MODEL`) failed *again*
        (2026-08-07), this time inside a delegated subagent run: `tool_use_failed:
        additionalProperties 'lineStart', 'lineEnd' not allowed` on a
        `read_file` call — the model invented extra arguments `read_file`'s
        schema doesn't have. Third distinct `tool_use_failed` flavor
        observed from `gpt-oss` models this project (missing required arg;
        empty/catch-all args; now hallucinated extra args). Not a subagent
        bug — `runSubagent` passed the exact same `read_file` schema
        `ALL_TOOLS` always uses — but it does mean an uncaught subagent-side
        model error currently crashes the whole delegating
        `runOrchestrator` call (no try/catch around delegation in
        `orchestrator.ts` yet). The REPL (`App.tsx`) recovers from this at
        the turn level already (logs `[error] ...`, returns to the prompt),
        so it's not fatal to a REPL session, but the standalone
        `orchestrator.ts` CLI path would still crash the process on it.
      - `moonshotai/kimi-k2-instruct`, `qwen/qwen3-32b` — do **not exist** on
        this Groq account (confirmed via `GET
        https://api.groq.com/openai/v1/models`); don't reuse these model
        names. The account's actual available chat models are:
        `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`,
        `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b`,
        `groq/compound`, `groq/compound-mini` (the last two are Groq's own
        agentic/tool-orchestrating models, untested here).
  - All five tools (see below — not just four; `search_files` was added
    after the original 4-tool scaffold and is included here too) are
    defined with the AI SDK's `tool()` helper + Zod `inputSchema`s, and
    **deliberately have no `execute` function** — that's what makes
    `generateText` return `toolCalls` instead of auto-running them, so each
    call can go through `checkPermission()` first.
  - Loop, capped at `MAX_ITERATIONS = 30`: call `generateText` → push
    `result.responseMessages` (assistant turn, incl. tool-call parts) onto
    the message history → if no tool calls, stop (`status: "completed"`) →
    otherwise, for each tool call: `checkPermission()`, then `deny` → push a
    `{ type: "execution-denied", reason }` tool-result part and skip
    execution; `ask` → call `handlers.requestApproval(request)` and await
    its `Promise<boolean>`, decline behaves like `deny` (reason `"user
    declined"`); `allow`/`ask`+approved → actually run the tool and push a
    `{ type: "json", value }` tool-result part. Push the accumulated
    tool-result message, loop.
  - Hitting the iteration cap returns `status: "max_iterations"` rather than
    throwing.
  - **UI-agnostic now (2026-08-04)** — the loop no longer calls
    `console.log`/`readline` directly. It takes a required `handlers:
    OrchestratorHandlers` param: `onEvent(event: OrchestratorEvent)` (fired
    for every step — `iteration-start`, `assistant-text`, `tool-call`,
    `tool-denied`, `tool-result`, `done`, `max-iterations`) and
    `requestApproval(request: ApprovalRequest): Promise<boolean>` (called
    only for `ask`-decision tool calls). `App.tsx` implements these against
    Ink; a `consoleHandlers(rl)` factory at the bottom of `orchestrator.ts`
    implements them against `console.log`/readline for running the file
    directly. Tool execution, permission checks, the message loop, and the
    reasoning-stripping workaround below are all unchanged — only how
    progress is reported changed.
  - **`runOrchestrator` now takes an optional `history: ModelMessage[] = []`
    4th param and returns it back (updated) as `OrchestratorResult.messages`
    (2026-08-04, for the REPL — see App.tsx notes above).** `messages` is
    built as `[...history, { role: "user", content: task }]` instead of
    always starting fresh from just the task. Callers that don't care about
    multi-turn (the standalone CLI entry point at the bottom of this file)
    simply omit `history` and ignore `.messages` on the result — fully
    backward compatible, this was an additive change.
  - Can be run directly for manual testing: `npx tsx src/orchestrator.ts
    "<task>"` (guarded by an `import.meta.url` check so importing
    `runOrchestrator` elsewhere doesn't auto-run anything) — uses
    `consoleHandlers` and `DEFAULT_MODEL`.
  - Verified: `tsc --noEmit` clean; both the direct CLI path
    (`consoleHandlers`/readline) and the Ink UI path (`App.tsx`, including
    the interactive approval keypress under a real pty) exercised live
    against real Portkey/Groq calls post-refactor — see the `App.tsx` notes
    above for what exactly was tested and the exit-timing bug found along
    the way. (Earlier testing note, still true of the direct CLI path: a
    single piped `echo "y"` can close stdin before the network round-trip
    finishes and crash the readline prompt with `ERR_USE_AFTER_CLOSE` — a
    test-harness artifact of piping input, not a bug in real interactive use
    where stdin stays open.)
  - **`src/llm.ts` was skipped, then deleted (2026-08-04).** The original
    plan (see `AGENTS.md`) was a hand-written provider-agnostic `llm.ts`
    abstraction that `orchestrator.ts` would call, with adapters added
    per-provider lazily. Instead, the AI Gateway (via the `ai` package,
    called directly from `orchestrator.ts`) now serves that role — switching
    providers/models is just changing the model string, no adapter code
    needed. The stale stub was removed by explicit user decision rather than
    left to confuse future sessions; re-add deliberately if a concrete need
    for a hand-rolled fallback path shows up later.
- **`src/agentRuntime.ts` — new shared module (2026-08-07)**, extracted from
  `orchestrator.ts` to make the subagent system below possible without
  duplicating tool schemas. Exports `createPortkeyModel`, `ALL_TOOLS` (the
  five real tools' AI-SDK `tool()` definitions — the single source of truth
  both `orchestrator.ts`'s main loop and `subagents/runSubagent.ts` build
  their tool sets from), `ToolName` (`keyof typeof ALL_TOOLS`), `toToolCall`,
  `executeToolCall`, and `stripReasoningParts`. `orchestrator.ts` no longer
  defines any of these itself — it imports them and layers `delegate_task`
  on top (see below). No behavior change for the existing 5 tools; this was
  a pure extraction.
- **`src/subagents/` — generic, registry-based subagent system, new
  (2026-08-07)**. Only one subagent registered so far ("explorer"), but
  adding another should only ever require touching `registry.ts` — verified
  by construction, not just claimed (see the mechanism below).
  - `types.ts` — `SubagentDefinition = { name, description, systemPrompt,
    tools: ToolName[], maxIterations }`. `tools` is typed against
    `agentRuntime.ts`'s `ToolName`, so it can only ever contain real,
    executable tool names — `"delegate_task"` isn't a member of that type
    because `ALL_TOOLS` never defines it, making nested delegation
    impossible to even express, not just something to check for.
  - `registry.ts` — exports `SUBAGENTS: SubagentDefinition[]`. The
    "explorer" entry: `tools: ["read_file", "search_files"]`,
    `maxIterations: 10`, and a `description` deliberately written as a
    routing rule (what to use it for / what not to, concrete examples) —
    same pattern as this project's own `Explore` agent type, not a vague
    one-line label — since it's what `orchestrator.ts` interpolates into
    `delegate_task`'s tool description for the model to route on.
    **On module load**, asserts no `SUBAGENTS` entry's `tools` array
    contains `"delegate_task"`, throwing immediately if one does — a
    runtime safety net for the no-nested-delegation guarantee, on top of
    (not instead of) the compile-time one from `types.ts` above, in case a
    future entry's `tools` is ever built dynamically instead of written as
    a literal.
  - `runSubagent.ts` — `runSubagent(def, task, modelKey): Promise<string>`.
    Its own `generateText` loop, own message history (never sees or shares
    the delegating orchestrator's conversation), own iteration cap
    (`def.maxIterations`, independent of the main loop's
    `MAX_ITERATIONS = 30`). Tool set is built as
    `Object.fromEntries(def.tools.map((name) => [name, ALL_TOOLS[name]]))`
    — literally cannot include a tool outside `ALL_TOOLS`. **No
    `checkPermission()` call anywhere in this file, by design**: that's
    only safe because every tool a `SubagentDefinition` can list is
    required to already be classified read-only in `permissions.ts`. If a
    non-read-only tool (`write_file`, `run_command`, `run_tests`) is ever
    added to a subagent's `tools`, this loop would execute it with no
    approval gate — don't do that without adding permission checking here
    too.
  - `orchestrator.ts` changes: added one tool, `delegate_task` — `{
    subagent: z.enum(SUBAGENTS.map(s => s.name)), task: z.string() }`,
    description built by interpolating every `SUBAGENTS` entry's own
    `description` (so the tool's description — and therefore the model's
    routing — updates automatically as subagents are added/removed from
    the registry, no hardcoded per-subagent text in `orchestrator.ts`
    itself). `checkPermission` (`permissions.ts`) classifies it `allow`
    ("delegates to a registered subagent restricted to read-only tools").
    Execution: looks up the matching `SubagentDefinition` by name in
    `SUBAGENTS`, fires a `"delegation-start"` event, calls `runSubagent()`,
    fires `"delegation-end"` with the summary. Both new
    `OrchestratorEvent` variants are logged the same as every other event
    (console handler + `App.tsx`'s `formatEvent`, so REPL sessions see
    delegation happen live, same as any other tool call).
  - **Verified live, per the task's own exit criteria**:
    - A task requiring exploration first (`"find where checkPermission is
      defined and every file that calls it"`) correctly triggered
      `delegate_task({subagent: "explorer", ...})` on iteration 1.
    - The summary stayed short: the subagent's own internal exploration
      (multiple `search_files`/`read_file` calls, a longer structured
      answer) never reached the main conversation — the orchestrator's
      final answer back to the user was 264 characters, built from the
      subagent's summary rather than the raw exploration.
    - **Structural-impossibility check (the important one)**: called
      `runSubagent()` directly with a task that explicitly asked the
      explorer subagent to write a file and run a shell command. No file
      was created, no command executed, and the subagent's own response
      was "I cannot fulfill this request... I do not have tools for
      writing files or executing shell commands" — not a refusal layered
      on top of capability, an actual absence of the tool in the schema
      `generateText` was called with. Confirmed by construction, not just
      by the model's stated behavior.
- **Plan-tracking (`update_plan`), new (2026-08-08)** — a 7th tool on
  `orchestrator.ts`'s own `tools` object (alongside `delegate_task`), not
  part of `agentRuntime.ts`'s `ALL_TOOLS`/not given to subagents (out of
  scope for this change — subagents run short, self-contained tasks with a
  10-iteration cap and don't need plan visibility of their own).
  - Schema: `{ steps: { step: string; status: "pending" | "in_progress" |
    "completed" }[] }`. Execution just calls `updatePlan()`
    (`tools/updatePlan.ts`) — a pass-through, no side effect.
  - **Plan is loop-local state** (`let plan: PlanStep[] = []` inside
    `runOrchestrator`), explicitly *not* global and *not* part of
    `OrchestratorResult` — resets every call, i.e. every REPL turn starts
    with an empty plan regardless of what the previous turn's plan was.
  - Every `update_plan` call emits a new `"plan-updated"` event (full
    `steps` array, not a diff) through the same `OrchestratorEvent`
    mechanism as every other tool call — logged by `consoleHandlers` (a
    `[plan]` block with `[x]`/`[~]`/`[ ]` markers) and, in `App.tsx`,
    intercepted before it reaches the scrolling log at all.
  - **`App.tsx` renders it as a separate, persistent `<PlanChecklist>`**
    (not appended to the `<Static>` log like other events) — `[x]` green
    for completed, `[~]` yellow for in_progress, `[ ]` for pending, and it
    re-renders in place as steps change rather than accumulating history.
    Cleared at the start of every `runTurn()` call to mirror the backend's
    loop-local reset, so a stale plan from a previous turn never lingers
    on screen.
  - **`SYSTEM_PROMPT` nudges the model to use it** ("For any task with more
    than one distinct step, call update_plan at the start... Single-step
    tasks don't need it") — without this line the tool exists but nothing
    prompts the model to actually call it.
  - **Deliberately not a gate**: nothing in the loop requires a plan to
    exist, checks whether one was ever created, or blocks any other tool
    call on plan state. Purely visibility.
  - **Verified live**: a genuine 3-step task (read two config files, then
    summarize) correctly called `update_plan` at the start and after each
    step (`pending`→`in_progress`→`completed` progression observed exactly
    as expected), no approval prompt was requested for any `update_plan`
    call (confirms the `allow` classification), and the checklist markers
    (`[ ]`/`[~]`/`[x]`) were confirmed actually rendered in the real Ink UI
    under a pty, not just present in the backend event stream. Separately,
    a trivial single-step task ("say hi") completed with zero tool calls at
    all, confirming the nudge doesn't force plan creation for tasks that
    don't need one.

### Not started
- `--yes` flag (skip approval prompts) — mentioned in the original
  `index.tsx` TODO but not implemented; only `--model` exists so far.
- No automated test suite for this repo's own code (tools were manually
  smoke-tested; orchestrator/App wiring was manually verified live per the
  notes above). Everything verified so far has been ad hoc, not a repeatable
  test.
- **Scriptable one-shot mode via `index.tsx` was dropped when it became a
  REPL (2026-08-04).** Before this change, `cli-agent "<task>"` ran once and
  exited with a status-derived exit code — useful for CI/scripting. Now it
  always drops into the interactive prompt after any initial task, and only
  exits (code 0) on explicit `/exit`/`/quit`, so shell scripts can no longer
  rely on it exiting after one task. The standalone `orchestrator.ts` direct
  entry point still behaves the old single-shot way and remains usable for
  scripting — but if genuine `index.tsx`-level one-shot/scriptable usage
  (e.g. a future `-p`/print-mode flag, matching how Claude Code separates
  interactive from `-p`) turns out to matter, that's new work, not something
  already covered elsewhere.

## Suggested build order

Roughly bottom-up, since each layer's interface is a dependency for the one
above it:

1. ~~`src/tools/*.ts`~~ — done.
2. ~~`src/permissions.ts`~~ — done, wired into `orchestrator.ts`.
3. ~~`src/llm.ts`~~ — skipped, then deleted; superseded by calling the
   provider (now Portkey, was Vercel AI Gateway) directly from
   `orchestrator.ts` (see note above).
4. ~~`src/orchestrator.ts`~~ — done, verified against live Portkey/Groq
   calls across 5 models; now UI-agnostic via `OrchestratorHandlers`, and
   supports multi-turn history threading via an optional `history` param.
5. ~~`src/ui/App.tsx`~~ — done: REPL-style, renders the orchestrator's step
   events via `<Static>`, real y/n approval prompt via Ink's `useInput`
   (not readline), typed task input via `ink-text-input`, persists
   conversation history across turns until `/exit`/`/quit`.
6. ~~`src/index.tsx`~~ — done: optional task argument + `--model` flag +
   interactive picker, renders `<App initialTask model onExit />`. `--yes`
   still open (see above).
7. ~~`src/agentRuntime.ts` + `src/subagents/`~~ — done: shared tool
   runtime extracted, generic registry-based subagent system built on top,
   one "explorer" subagent registered. See the dedicated notes above for
   what was verified live.
8. ~~`src/tools/updatePlan.ts` + plan-tracking wiring~~ — done: `update_plan`
   tool, loop-local plan state + `plan-updated` event in `orchestrator.ts`,
   persistent checklist in `App.tsx`. See the dedicated notes above.

All 8 build-order items are now done; remaining work is the "Not started"
items above plus whatever the "Open decisions" below resolve to.

## Open decisions (not yet made — flag before assuming)

- **Resolved (2026-08-07): `DEFAULT_MODEL` switched from `gpt-oss-20b` to
  `qwen/qwen3.6-27b`**, by explicit request, after `gpt-oss-20b` hit a third
  distinct `tool_use_failed` flavor (this time inside a delegated subagent
  run — see the subagent notes above). `qwen3.6-27b` had zero observed
  tool-call failures across every test this project, including this
  change's own verification (main loop + a `delegate_task` call, both with
  no `modelKey` passed explicitly, confirmed both resolved to
  `qwen3.6-27b` and completed without error). `src/models.ts`'s labels for
  both models were updated to reflect this.
- Whether `llama-3.1-8b-instant` should be added to `src/models.ts` — it
  was also fully reliable in live testing (see orchestrator.ts notes above)
  but was deliberately left out of the 3-model registry by explicit
  request, unchanged by the `DEFAULT_MODEL` switch above. Revisit if
  `qwen3.6-27b` ever proves flaky in practice.
- Whether the scaled/cloud architecture (queue, workers, durable Vercel
  Workflow orchestrator, sandbox pool — see architecture.md §2) is an actual
  near-term goal or a later-phase idea. Current implementation work should
  target **local execution only** (architecture.md §1) unless told otherwise.
- Whether this becomes a git repo, and when — currently `git init` has not
  been run.
- **Whether `runOrchestrator` should catch errors thrown from
  `runSubagent()` and turn them into a failed-delegation tool result,
  instead of letting them propagate and crash the whole run.** Currently a
  model error inside a delegated subagent (e.g. the `gpt-oss-20b`
  `tool_use_failed` noted above, observed live from inside a subagent call)
  crashes `runOrchestrator` the same way any other uncaught error does. The
  REPL (`App.tsx`) already recovers at the turn level regardless, but the
  standalone `orchestrator.ts` CLI path does not. Not fixed yet — flagged
  during subagent testing, not asked for in the original spec.

## Notes for the next agent session

- Don't build sandbox-based isolation — the local-execution model
  intentionally has none; the permission layer's human-approval gate is the
  whole security boundary.
- Don't pre-build multiple LLM provider adapters speculatively — AI Gateway
  already gives provider-agnosticism via the model string; there's no
  separate adapter layer to add to.
- When adding a new subagent, only touch `src/subagents/registry.ts` — if
  you find yourself editing `orchestrator.ts`, `runSubagent.ts`, or
  `agentRuntime.ts` to add one, something's wrong with the approach; that
  was the explicit design goal and it's been verified to hold for the one
  entry that exists so far.
- Don't give a subagent a non-read-only tool (`write_file`, `run_command`,
  `run_tests`) without also adding permission checking to
  `runSubagent.ts` — it currently has none, deliberately, because every
  tool a subagent can be given today is required to already be
  unconditionally safe.
