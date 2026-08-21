# cli-agent

A local CLI coding agent: natural-language task → LLM tool-call loop →
permission-gated execution. Runs as a persistent REPL in your terminal.

```
> list the files in this repo and summarize what this project does
```

## What it is

`cli-agent` runs entirely as **one local Node process** — the only thing
that ever leaves your machine is the LLM call itself, routed through
[Portkey](https://portkey.ai) to [Groq](https://groq.com). There's no
sandbox: the permission layer's human-approval gate on irreversible actions
is the entire security boundary.

```
REPL (type a task)
  → Orchestrator loop — calls Portkey → Groq for the next tool call
    → Permission Scope Layer — auto-allow read-only/reversible, ask for
      irreversible, deny known-dangerous patterns
      → a real tool (filesystem / shell)
      → delegate_task → an isolated, read-only subagent
      → update_plan → a live progress checklist
  → result feeds back into history, loop continues or the turn ends
```

## Setup

```bash
npm install
```

You'll need a [Portkey](https://portkey.ai) API key with a Groq integration
configured. Create a `.env` file:

```
PORTKEY_API_KEY=your-key-here
```

## Usage

```bash
set -a && source .env && set +a
npx tsx src/index.tsx
```

No task argument needed — it drops you straight into an interactive
prompt. Pick a model (or skip the picker with `--model <key>`), then just
type tasks:

```bash
npx tsx src/index.tsx --model qwen3.6-27b
npx tsx src/index.tsx "find where checkPermission is defined"   # seed the first task
```

Conversation history carries across turns. `/exit` or `/quit` to leave.

## Tools

| Tool | Does | Approval |
|---|---|---|
| `read_file` | Read a file | auto-allowed |
| `search_files` | Grep-like content search | auto-allowed |
| `write_file` | Write a file (creates parent dirs) | auto-allowed inside the project dir |
| `run_tests` | Run the test suite | auto-allowed inside the project dir |
| `run_command` | Arbitrary shell command | **asks for y/n every time**; hard-denied for `sudo`, `rm -rf`-style patterns, `git push --force` |
| `delegate_task` | Hand a task to a registered subagent — isolated context, read-only tools only, returns a summary | auto-allowed |
| `update_plan` | Record/update a live progress checklist | auto-allowed, visibility only — never blocks anything |

## Subagents

Subagents are generic and registry-based (`src/subagents/registry.ts`) —
adding one only ever requires an entry there. One is registered today:
`explorer`, restricted to `read_file`/`search_files`. A subagent's tool set
is always a subset of the main loop's tools and is structurally incapable
of including `delegate_task` — it can't write files, run commands, or
delegate further, not because it's told not to, but because those tools
don't exist in its schema.

## Models

Three Groq models are selectable, reached through Portkey via
`@ai-sdk/openai-compatible` (no vendor SDK):

| Key | Notes |
|---|---|
| `qwen3.6-27b` | **Default.** Most reliable in testing — no observed tool-call failures. |
| `gpt-oss-120b` | Strong reasoning, but the free-tier rate limit (8000 TPM) is easy to blow past. |
| `gpt-oss-20b` | Smaller/faster, but has repeatedly hit tool-call schema errors in testing. |

Switching models is a one-line change in `src/models.ts` — no adapter code.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run dev          # tsx src/index.tsx
```

See [AGENTS.md](./AGENTS.md) for architecture conventions and
[PROGRESS.md](./PROGRESS.md) for implementation status and history — start
there before making changes.
