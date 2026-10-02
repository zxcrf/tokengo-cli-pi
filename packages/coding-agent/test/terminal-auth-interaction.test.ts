import { describe, expect, it } from "vitest";
import { createTerminalAuthInteraction, type TerminalAuthInput } from "../src/cli/terminal-auth-interaction.ts";

class FakeInput implements TerminalAuthInput {
	isTTY: boolean;
	rawModes: boolean[] = [];
	listeners = new Set<(chunk: string) => void>();
	endListeners = new Set<() => void>();
	paused = true;
	constructor(isTTY = true) {
		this.isTTY = isTTY;
		if (isTTY) this.setRawMode = (mode: boolean) => this.rawModes.push(mode);
	}
	setRawMode?: (mode: boolean) => unknown;
	setEncoding(): void {}
	on(event: "data", listener: (chunk: string) => void): void;
	on(event: "end", listener: () => void): void;
	on(event: "data" | "end", listener: ((chunk: string) => void) | (() => void)): void {
		if (event === "data") this.listeners.add(listener as (chunk: string) => void);
		else this.endListeners.add(listener as () => void);
	}
	off(event: "data", listener: (chunk: string) => void): void;
	off(event: "end", listener: () => void): void;
	off(event: "data" | "end", listener: ((chunk: string) => void) | (() => void)): void {
		if (event === "data") this.listeners.delete(listener as (chunk: string) => void);
		else this.endListeners.delete(listener as () => void);
	}
	end(): void {
		for (const listener of [...this.endListeners]) listener();
	}
	resume(): void {
		this.paused = false;
	}
	pause(): void {
		this.paused = true;
	}
	send(chunk: string): void {
		for (const listener of [...this.listeners]) listener(chunk);
	}
}

function fakeOutput(): { write(text: string): void; text(): string } {
	const chunks: string[] = [];
	return { write: (text) => void chunks.push(text), text: () => chunks.join("") };
}

describe("createTerminalAuthInteraction", () => {
	it("reads a secret without echoing it and restores the terminal", async () => {
		const input = new FakeInput();
		const output = fakeOutput();
		const interaction = createTerminalAuthInteraction({ input, output });

		const answer = interaction.prompt({ type: "secret", message: "Token" });
		input.send("a");
		input.send("bcX");
		input.send("\u007f");
		input.send("d\r");

		expect(await answer).toBe("abcd");
		expect(output.text()).not.toMatch(/[abcd]{2}/u);
		expect(output.text()).toBe("Token: \n");
		expect(input.rawModes).toEqual([true, false]);
		expect(input.paused).toBe(true);
		expect(input.listeners.size).toBe(0);
	});

	it("accepts a multi-character paste", async () => {
		const input = new FakeInput();
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		const answer = interaction.prompt({ type: "secret", message: "Token" });
		input.send("pat-secret-123\n");
		expect(await answer).toBe("pat-secret-123");
	});

	it("rejects with Login cancelled on Ctrl-C", async () => {
		const input = new FakeInput();
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		const answer = interaction.prompt({ type: "secret", message: "Token" });
		input.send("ab");
		input.send("\u0003");
		await expect(answer).rejects.toThrow("Login cancelled");
		expect(input.rawModes).toEqual([true, false]);
	});

	it("rejects on Ctrl-D with empty input but ignores it after typing", async () => {
		const input = new FakeInput();
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		const empty = interaction.prompt({ type: "secret", message: "Token" });
		input.send("\u0004");
		await expect(empty).rejects.toThrow("Login cancelled");

		const typed = interaction.prompt({ type: "secret", message: "Token" });
		input.send("a\u0004b\r");
		expect(await typed).toBe("ab");
	});

	it("fails with guidance when no terminal is available", async () => {
		const input = new FakeInput(false);
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		await expect(interaction.prompt({ type: "secret", message: "Token" })).rejects.toThrow(
			"No terminal available to prompt for a secret. Pass --token <pat> or set TOKENGO_PAT.",
		);
	});

	it("answers only the first secret prompt with presetSecret", async () => {
		const input = new FakeInput();
		const output = fakeOutput();
		const interaction = createTerminalAuthInteraction({ input, output, presetSecret: "preset" });
		expect(await interaction.prompt({ type: "secret", message: "First" })).toBe("preset");
		expect(input.rawModes).toEqual([]);
		expect(output.text()).toBe("");

		const second = interaction.prompt({ type: "secret", message: "Second" });
		input.send("typed\r");
		expect(await second).toBe("typed");
	});

	it("maps a numbered select answer to the option id", async () => {
		const input = new FakeInput(false);
		const output = fakeOutput();
		const interaction = createTerminalAuthInteraction({ input, output });
		const options = [
			{ id: "one", label: "First" },
			{ id: "two", label: "Second" },
		];
		const answer = interaction.prompt({ type: "select", message: "Pick", options });
		input.send("2\n");
		expect(await answer).toBe("two");
		expect(output.text()).toContain("1. First");
		expect(output.text()).toContain("Enter number (1-2): ");

		const invalid = interaction.prompt({ type: "select", message: "Pick", options });
		input.send("9\n");
		await expect(invalid).rejects.toThrow("Invalid selection");
	});

	it("answers consecutive prompts from one chunk containing several lines", async () => {
		const input = new FakeInput(false);
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		const options = [
			{ id: "one", label: "First" },
			{ id: "two", label: "Second" },
		];
		const first = interaction.prompt({ type: "select", message: "Pick", options });
		input.send("2\r\ncode\npart");
		expect(await first).toBe("two");
		expect(await interaction.prompt({ type: "text", message: "Code" })).toBe("code");

		const third = interaction.prompt({ type: "text", message: "More" });
		input.send("ial\n");
		expect(await third).toBe("partial");
		expect(input.listeners.size).toBe(0);
		expect(input.endListeners.size).toBe(0);
	});

	it("rejects a pending line prompt on EOF and every later one", async () => {
		const input = new FakeInput(false);
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		const pending = interaction.prompt({ type: "text", message: "Name" });
		input.end();
		await expect(pending).rejects.toThrow("Login cancelled");
		expect(input.endListeners.size).toBe(0);
		await expect(interaction.prompt({ type: "text", message: "Again" })).rejects.toThrow("Login cancelled");
	});

	it("drops escape sequences anywhere in a secret chunk", async () => {
		const input = new FakeInput();
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		const answer = interaction.prompt({ type: "secret", message: "Token" });
		input.send("\u001b[200~ab\u001b[Acd\u001bOP\u001b[201~\r");
		expect(await answer).toBe("abcd");
	});

	it("deletes a whole code point on Backspace", async () => {
		const input = new FakeInput();
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		const answer = interaction.prompt({ type: "secret", message: "Token" });
		input.send("a\u{1F600}\u007fb\r");
		expect(await answer).toBe("ab");
	});

	it("reads a text line", async () => {
		const input = new FakeInput(false);
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		const answer = interaction.prompt({ type: "text", message: "Name" });
		input.send("ali");
		input.send("ce\n");
		expect(await answer).toBe("alice");
	});

	it("rejects with the abort reason when the prompt signal aborts", async () => {
		const input = new FakeInput();
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput() });
		const controller = new AbortController();
		const answer = interaction.prompt({ type: "secret", message: "Token", signal: controller.signal });
		controller.abort(new Error("callback won"));
		await expect(answer).rejects.toThrow("callback won");
		expect(input.rawModes).toEqual([true, false]);
		expect(input.listeners.size).toBe(0);
	});

	it("rejects immediately when the interaction signal is already aborted", async () => {
		const input = new FakeInput();
		const controller = new AbortController();
		controller.abort(new Error("stop"));
		const interaction = createTerminalAuthInteraction({ input, output: fakeOutput(), signal: controller.signal });
		await expect(interaction.prompt({ type: "text", message: "Name" })).rejects.toThrow("stop");
		expect(input.listeners.size).toBe(0);
	});

	it("writes notifications to the output", () => {
		const output = fakeOutput();
		const interaction = createTerminalAuthInteraction({ input: new FakeInput(), output });
		interaction.notify({ type: "info", message: "Hello", links: [{ url: "https://a.test" }] });
		interaction.notify({ type: "progress", message: "Working" });
		interaction.notify({ type: "auth_url", url: "https://b.test" });
		interaction.notify({ type: "device_code", userCode: "ABCD", verificationUri: "https://c.test" });
		expect(output.text()).toBe(
			"Hello\n  https://a.test\nWorking\nOpen this URL in your browser:\nhttps://b.test\nOpen https://c.test and enter code: ABCD\n",
		);
	});
});
