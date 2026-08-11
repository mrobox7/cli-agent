#!/usr/bin/env node
import { Command } from "commander";
import { select } from "@inquirer/prompts";
import { render } from "ink";
import App from "./ui/App.js";
import { MODELS, DEFAULT_MODEL, type ModelKey } from "./models.js";

async function resolveModel(flag?: string): Promise<ModelKey> {
	if (flag) {
		if (flag in MODELS) return flag as ModelKey;
		console.warn(`Unknown model "${flag}", falling back to picker.`);
	}

	if (process.stdout.isTTY) {
		return select({
			message: "Select a model:",
			choices: Object.entries(MODELS).map(([key, m]) => ({ name: m.label, value: key as ModelKey })),
			default: DEFAULT_MODEL,
		});
	}

	return DEFAULT_MODEL;
}

const program = new Command();

program
	.name("cli-agent")
	.description("Local CLI coding agent")
	.version("0.1.0")
	.argument("[task]", "natural-language task to run first (omit to start straight in the prompt)")
	.option("--model <key>", `model to use (${Object.keys(MODELS).join(", ")})`)
	.action(async (task: string | undefined, options: { model?: string }) => {
		const modelKey = await resolveModel(options.model);
		// @inquirer/prompts leaves stdin paused after its readline interface
		// closes; Ink's raw-mode input relies on stdin actually flowing, so
		// without this the app renders once and the process exits immediately
		// with no way to type anything.
		process.stdin.resume();
		let exitCode = 0;
		const { waitUntilExit } = render(
			<App
				initialTask={task}
				model={modelKey}
				onExit={(code) => {
					exitCode = code;
				}}
			/>,
		);
		await waitUntilExit();
		process.exit(exitCode);
	});

program.parseAsync();
