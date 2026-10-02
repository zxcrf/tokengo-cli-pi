import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export interface TerminalAuthInput {
	readonly isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
	setEncoding(encoding: BufferEncoding): unknown;
	on(event: "data", listener: (chunk: string) => void): unknown;
	on(event: "end", listener: () => void): unknown;
	off(event: "data", listener: (chunk: string) => void): unknown;
	off(event: "end", listener: () => void): unknown;
	resume(): unknown;
	pause(): unknown;
}

export interface TerminalAuthOutput {
	write(text: string): unknown;
}

export interface TerminalAuthInteractionOptions {
	input: TerminalAuthInput;
	output: TerminalAuthOutput;
	signal?: AbortSignal;
	/** Answers the first secret prompt only, without touching the terminal. */
	presetSecret?: string;
}

const CANCELLED_MESSAGE = "Login cancelled";
const NO_TERMINAL_MESSAGE = "No terminal available to prompt for a secret. Pass --token <pat> or set TOKENGO_PAT.";

// CSI (including bracketed-paste markers), SS3, and bare ESC-prefixed keys.
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|O.|.)?/gsu;

function isPrintable(char: string): boolean {
	return char >= " " && char !== "\u007f";
}

export function createTerminalAuthInteraction(options: TerminalAuthInteractionOptions): AuthInteraction {
	const { input, output } = options;
	let presetSecret = options.presetSecret;
	/** Text received after the newline that ended a line, kept for the next prompt. */
	let leftover = "";
	let ended = false;

	function takeLine(buffer: string): { line: string; rest: string } | undefined {
		const newline = buffer.search(/[\r\n]/u);
		if (newline === -1) return undefined;
		const skip = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
		return { line: buffer.slice(0, newline), rest: buffer.slice(newline + skip) };
	}

	function readInput(label: string, mode: "secret" | "line", promptSignal?: AbortSignal): Promise<string> {
		const signals = [options.signal, promptSignal].filter((entry): entry is AbortSignal => entry !== undefined);
		const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const raw = Boolean(input.isTTY && input.setRawMode);
		if (mode === "secret" && !raw) return Promise.reject(new Error(NO_TERMINAL_MESSAGE));

		if (!raw) {
			output.write(label);
			const buffered = takeLine(leftover);
			if (buffered) {
				leftover = buffered.rest;
				return Promise.resolve(buffered.line);
			}
			if (ended) return Promise.reject(new Error(CANCELLED_MESSAGE));
		}

		return new Promise<string>((resolve, reject) => {
			let buffer = raw ? "" : leftover;
			if (!raw) leftover = "";
			let finished = false;

			const finish = (outcome: { value: string } | { error: unknown }): void => {
				if (finished) return;
				finished = true;
				input.off("data", onData);
				input.off("end", onEnd);
				signal?.removeEventListener("abort", onAbort);
				if (raw) input.setRawMode?.(false);
				input.pause();
				if ("error" in outcome) reject(outcome.error);
				else resolve(outcome.value);
			};
			const onAbort = (): void => {
				output.write("\n");
				finish({ error: signal?.reason });
			};
			const onEnd = (): void => {
				ended = true;
				output.write("\n");
				finish({ error: new Error(CANCELLED_MESSAGE) });
			};
			const onData = (chunk: string): void => {
				if (!raw) {
					buffer += chunk;
					const complete = takeLine(buffer);
					if (complete) {
						leftover = complete.rest;
						finish({ value: complete.line });
					}
					return;
				}
				for (const char of chunk.replace(ESCAPE_SEQUENCE, "")) {
					if (char === "\u0003" || (char === "\u0004" && buffer.length === 0)) {
						output.write("\n");
						finish({ error: new Error(CANCELLED_MESSAGE) });
						return;
					}
					if (char === "\r" || char === "\n") {
						output.write("\n");
						finish({ value: buffer });
						return;
					}
					if (char === "\u007f" || char === "\b") {
						if (buffer.length > 0) {
							buffer = Array.from(buffer).slice(0, -1).join("");
							if (mode === "line") output.write("\b \b");
						}
						continue;
					}
					if (!isPrintable(char)) continue;
					buffer += char;
					if (mode === "line") output.write(char);
				}
			};

			if (raw) output.write(label);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (raw) input.setRawMode?.(true);
			input.setEncoding("utf8");
			input.on("data", onData);
			input.on("end", onEnd);
			input.resume();
		});
	}

	function describe(prompt: { message: string; placeholder?: string }): string {
		return `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `;
	}

	async function prompt(authPrompt: AuthPrompt): Promise<string> {
		if (authPrompt.type === "secret") {
			if (presetSecret !== undefined) {
				const value = presetSecret;
				presetSecret = undefined;
				return value;
			}
			return readInput(describe(authPrompt), "secret", authPrompt.signal);
		}
		if (authPrompt.type === "select") {
			const lines = authPrompt.options.map((option, index) => `  ${index + 1}. ${option.label}`);
			output.write(`${authPrompt.message}\n${lines.join("\n")}\n`);
			const answer = await readInput(`Enter number (1-${authPrompt.options.length}): `, "line", authPrompt.signal);
			const choice = Number.parseInt(answer.trim(), 10) - 1;
			const selected = authPrompt.options[choice];
			if (!selected) throw new Error("Invalid selection");
			return selected.id;
		}
		return readInput(describe(authPrompt), "line", authPrompt.signal);
	}

	function notify(event: AuthEvent): void {
		switch (event.type) {
			case "info": {
				const links = (event.links ?? []).map((link) => `  ${link.url}\n`).join("");
				output.write(`${event.message}\n${links}`);
				break;
			}
			case "progress":
				output.write(`${event.message}\n`);
				break;
			case "auth_url":
				output.write(`Open this URL in your browser:\n${event.url}\n`);
				if (event.instructions) output.write(`${event.instructions}\n`);
				break;
			case "device_code":
				output.write(`Open ${event.verificationUri} and enter code: ${event.userCode}\n`);
				break;
		}
	}

	return { signal: options.signal, prompt, notify };
}
