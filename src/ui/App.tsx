import { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ModelMessage } from "ai";
import {
	runOrchestrator,
	type ApprovalRequest,
	type OrchestratorEvent,
} from "../orchestrator.js";
import type { ModelKey } from "../models.js";
import type { PlanStep } from "../tools/updatePlan.js";

interface LogEntry {
	id: number;
	text: string;
}

interface PendingApproval {
	request: ApprovalRequest;
	resolve: (approved: boolean) => void;
}

export interface AppProps {
	// Task to run immediately on startup. If omitted, the session opens
	// straight into the input prompt.
	initialTask?: string;
	model: ModelKey;
	onExit?: (code: number) => void;
}

let nextLogId = 0;

// "done" isn't rendered directly — each turn ends with a single
// "[status] finalText" summary line printed by runTurn() instead, which
// carries more information than a bare "[done]" would. "plan-updated" isn't
// rendered here either — it's intercepted in runTurn()'s onEvent before it
// ever reaches formatEvent, since the plan is a persistent checklist
// (PlanChecklist below), not a line appended to the scrolling log.
function formatEvent(event: OrchestratorEvent): string | null {
	switch (event.type) {
		case "iteration-start":
			return `=== iteration ${event.iteration}/${event.maxIterations} ===`;
		case "assistant-text":
			return `[assistant] ${event.text}`;
		case "tool-call":
			return `[tool call] ${event.toolName}(${JSON.stringify(event.input)})`;
		case "tool-denied":
			return `[denied] ${event.reason}`;
		case "tool-result":
			return `[result] ${JSON.stringify(event.output)}`;
		case "delegation-start":
			return `[delegate → ${event.subagent}] ${event.task}`;
		case "delegation-end":
			return `[delegate ← ${event.subagent}] ${event.summary}`;
		case "max-iterations":
			return "[stopped] hit the iteration cap";
		case "done":
		case "plan-updated":
			return null;
	}
}

type Phase = "running" | "awaiting-input" | "exiting";

export default function App({ initialTask, model, onExit }: AppProps) {
	const { exit } = useApp();
	const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
	const [pending, setPending] = useState<PendingApproval | null>(null);
	const [phase, setPhase] = useState<Phase>(initialTask ? "running" : "awaiting-input");
	const [inputValue, setInputValue] = useState("");
	const [plan, setPlan] = useState<PlanStep[]>([]);
	const historyRef = useRef<ModelMessage[]>([]);
	const startedInitial = useRef(false);

	function pushLog(text: string) {
		setLogEntries((prev) => [...prev, { id: nextLogId++, text }]);
	}

	function runTurn(task: string) {
		setPhase("running");
		// Plan is loop-local to a single runOrchestrator call (see
		// orchestrator.ts) — clear it here so a previous turn's plan doesn't
		// linger on screen once a new turn starts.
		setPlan([]);
		pushLog(`> ${task}`);

		runOrchestrator(
			task,
			model,
			{
				onEvent(event) {
					if (event.type === "plan-updated") {
						setPlan(event.steps);
						return;
					}
					const text = formatEvent(event);
					if (text) pushLog(text);
				},
				requestApproval(request) {
					return new Promise<boolean>((resolve) => {
						setPending({ request, resolve });
					});
				},
			},
			historyRef.current,
		)
			.then((result) => {
				historyRef.current = result.messages;
				pushLog(`[${result.status}] ${result.finalText}`);
				setPhase("awaiting-input");
			})
			.catch((err: unknown) => {
				pushLog(`[error] ${err instanceof Error ? err.message : String(err)}`);
				setPhase("awaiting-input");
			});
	}

	// eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once, guarded below
	useEffect(() => {
		if (startedInitial.current) return;
		startedInitial.current = true;
		if (initialTask) runTurn(initialTask);
	}, []);

	useEffect(() => {
		if (phase === "exiting") exit();
	}, [phase, exit]);

	function handleSubmit(value: string) {
		const trimmed = value.trim();
		setInputValue("");
		if (!trimmed) return;
		if (trimmed === "/exit" || trimmed === "/quit") {
			onExit?.(0);
			setPhase("exiting");
			return;
		}
		runTurn(trimmed);
	}

	return (
		<Box flexDirection="column">
			<Text>cli-agent — model: {model} (type a task, or /exit to quit)</Text>
			{plan.length > 0 && <PlanChecklist steps={plan} />}
			<Static items={logEntries}>{(entry) => <Text key={entry.id}>{entry.text}</Text>}</Static>
			{pending && (
				<ApprovalPrompt
					request={pending.request}
					onAnswer={(approved) => {
						pending.resolve(approved);
						setPending(null);
					}}
				/>
			)}
			{phase === "awaiting-input" && !pending && (
				<Box>
					<Text>{"> "}</Text>
					<TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
				</Box>
			)}
		</Box>
	);
}

function ApprovalPrompt({
	request,
	onAnswer,
}: {
	request: ApprovalRequest;
	onAnswer: (approved: boolean) => void;
}) {
	useInput((input) => {
		const normalized = input.trim().toLowerCase();
		if (normalized === "y") onAnswer(true);
		else if (normalized === "n") onAnswer(false);
	});

	return (
		<Box flexDirection="column">
			<Text color="yellow">
				[approval needed] {request.reason}
			</Text>
			<Text color="yellow">
				{"  "}
				{request.toolName}({JSON.stringify(request.input)})
			</Text>
			<Text color="yellow">Approve? (y/n)</Text>
		</Box>
	);
}

// Persistent checklist, separate from the scrolling <Static> log — re-renders
// in place as steps change status, rather than appending a new line per
// update the way every other event does.
function PlanChecklist({ steps }: { steps: PlanStep[] }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			{steps.map((s) => (
				<Text key={s.step} color={planStepColor(s.status)}>
					{planStepMarker(s.status)} {s.step}
				</Text>
			))}
		</Box>
	);
}

function planStepMarker(status: PlanStep["status"]): string {
	switch (status) {
		case "completed":
			return "[x]";
		case "in_progress":
			return "[~]";
		case "pending":
			return "[ ]";
	}
}

function planStepColor(status: PlanStep["status"]): string | undefined {
	switch (status) {
		case "completed":
			return "green";
		case "in_progress":
			return "yellow";
		case "pending":
			return undefined;
	}
}
