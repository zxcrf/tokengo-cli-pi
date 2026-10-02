import type { ApiKeyCredential, Model, Provider } from "@earendil-works/pi-ai";
import {
	TOKEN_GO_DEFAULT_MODEL_ID,
	TOKEN_GO_ENV,
	TOKEN_GO_PROVIDER_ID,
} from "@earendil-works/pi-ai/providers/token-go";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLoginCommand } from "../src/cli/login-command.ts";
import type { TerminalAuthInput } from "../src/cli/terminal-auth-interaction.ts";
import { getAuthPath } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function textModel(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

interface TestProviderOptions {
	id: string;
	name: string;
	modelIds: readonly string[];
	login: (secret: string) => Promise<ApiKeyCredential>;
}

function testProvider(options: TestProviderOptions): Provider<"openai-completions"> {
	return {
		id: options.id,
		name: options.name,
		auth: {
			apiKey: {
				name: "API key",
				login: async (interaction) => options.login(await interaction.prompt({ type: "secret", message: "PAT" })),
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => options.modelIds.map((id) => textModel(options.id, id)),
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

class FakeInput implements TerminalAuthInput {
	isTTY = false;
	setEncoding(): void {}
	on(): void {}
	off(): void {}
	resume(): void {}
	pause(): void {}
}

function sink(): { write(text: string): void; text(): string } {
	const chunks: string[] = [];
	return { write: (text) => void chunks.push(text), text: () => chunks.join("") };
}

describe("runLoginCommand", () => {
	let savedExitCode: typeof process.exitCode;
	let credentials: AuthStorage;
	let runtime: ModelRuntime;
	let secrets: string[];
	let loginError: Error | undefined;

	beforeEach(async () => {
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
		secrets = [];
		loginError = undefined;
		credentials = AuthStorage.inMemory();
		runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
			allowedBuiltinProviders: [],
		});
		runtime.registerNativeProvider(
			testProvider({
				id: TOKEN_GO_PROVIDER_ID,
				name: "TokenGo",
				modelIds: ["gpt-5", TOKEN_GO_DEFAULT_MODEL_ID],
				login: async (secret) => {
					secrets.push(secret);
					if (loginError) throw loginError;
					return {
						type: "api_key",
						key: "sk-issued",
						env: { [TOKEN_GO_ENV.username]: "alice", [TOKEN_GO_ENV.group]: "tokengo" },
					};
				},
			}),
		);
		runtime.registerNativeProvider(
			testProvider({
				id: "other",
				name: "Other Co",
				modelIds: ["zeta", "alpha"],
				login: async (secret) => {
					secrets.push(secret);
					return { type: "api_key", key: "other-key" };
				},
			}),
		);
		await runtime.refresh({ allowNetwork: false });
	});

	afterEach(() => {
		process.exitCode = savedExitCode;
	});

	async function run(args: string[], env: Record<string, string | undefined> = { PI_OFFLINE: "1" }) {
		const output = sink();
		const errorOutput = sink();
		const handled = await runLoginCommand(args, {
			settingsManager: SettingsManager.inMemory(),
			modelRuntime: runtime,
			input: new FakeInput(),
			output,
			errorOutput,
			env,
		});
		return { handled, out: output.text(), err: errorOutput.text() };
	}

	it("returns false for other commands", async () => {
		expect((await run(["update"])).handled).toBe(false);
		expect((await run([])).handled).toBe(false);
		expect(process.exitCode).toBeUndefined();
	});

	it("prints usage for --help", async () => {
		const result = await run(["login", "--help"]);
		expect(result.handled).toBe(true);
		expect(result.out).toContain("login [provider] [--token <pat>]");
		expect(process.exitCode).toBeUndefined();
		expect((await run(["logout", "-h"])).out).toContain("logout [provider]");
	});

	it("logs in with --token and prints three lines", async () => {
		const result = await run(["login", "--token", "pat-123"]);
		expect(result.handled).toBe(true);
		expect(secrets).toEqual(["pat-123"]);
		expect(result.out.trimEnd().split("\n")).toEqual([
			"Logged in to TokenGo as alice (group tokengo).",
			`Credentials saved to ${getAuthPath()}`,
			`Models: 2 available. Suggested default: token-go/${TOKEN_GO_DEFAULT_MODEL_ID}`,
		]);
		expect(process.exitCode).toBeUndefined();
		expect(await credentials.read(TOKEN_GO_PROVIDER_ID)).toMatchObject({ type: "api_key", key: "sk-issued" });
	});

	it("accepts --token=value", async () => {
		await run(["login", "--token=pat-eq"]);
		expect(secrets).toEqual(["pat-eq"]);
	});

	it("falls back to TOKENGO_PAT for token-go only", async () => {
		await run(["login"], { PI_OFFLINE: "1", TOKENGO_PAT: "pat-env" });
		expect(secrets).toEqual(["pat-env"]);

		secrets = [];
		const result = await run(["login", "other"], { PI_OFFLINE: "1", TOKENGO_PAT: "pat-env" });
		expect(result.err).toContain("No terminal available to prompt for a secret");
		expect(secrets).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("prefers --token over TOKENGO_PAT", async () => {
		await run(["login", "--token", "flag"], { PI_OFFLINE: "1", TOKENGO_PAT: "env" });
		expect(secrets).toEqual(["flag"]);
	});

	it("uses the generic first line and first model for other providers", async () => {
		const result = await run(["login", "other", "--token", "t"]);
		expect(result.out.split("\n")[0]).toBe("Logged in to Other Co.");
		expect(result.out).toContain("Models: 2 available. Suggested default: other/zeta");
	});

	it("rejects unknown or disabled providers and lists enabled ones", async () => {
		const result = await run(["login", "nonexistent", "--token", "t"]);
		expect(process.exitCode).toBe(1);
		expect(result.err).toContain('Unknown or disabled provider "nonexistent". Enabled: ');
		expect(result.err).toContain("token-go");
		expect(result.err).toContain("other");
		expect(secrets).toEqual([]);
	});

	it("rejects bad arguments with usage", async () => {
		expect((await run(["login", "--bogus"])).err).toContain("Unknown option: --bogus");
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
		const extra = await run(["login", "a", "secret-looking-value"]);
		expect(extra.err).toContain("Unexpected argument.");
		expect(extra.err).not.toContain("secret-looking-value");
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
		expect((await run(["login", "--token"])).err).toContain("--token requires a value.");
		expect(process.exitCode).toBe(1);
	});

	it("exits 1 with the provider error message", async () => {
		loginError = Object.assign(new Error("token rejected"), { hint: "Generate a new token." });
		const result = await run(["login", "--token", "bad"]);
		expect(process.exitCode).toBe(1);
		expect(result.err).toContain("token rejected\nGenerate a new token.");
		expect(result.out).toBe("");
	});

	it("exits 130 when the login is cancelled", async () => {
		loginError = new Error("Login cancelled");
		const result = await run(["login", "--token", "t"]);
		expect(process.exitCode).toBe(130);
		expect(result.err).toBe("Login cancelled\n");
	});

	it("reports that no secret can be prompted without a terminal", async () => {
		const result = await run(["login"]);
		expect(process.exitCode).toBe(1);
		expect(result.err).toContain("Pass --token <pat> or set TOKENGO_PAT.");
	});

	it("logs out stored credentials", async () => {
		await run(["login", "--token", "t"]);
		const result = await run(["logout"]);
		expect(result.out).toBe(`Logged out of TokenGo. Removed credentials from ${getAuthPath()}.\n`);
		expect(await credentials.read(TOKEN_GO_PROVIDER_ID)).toBeUndefined();
		expect(process.exitCode).toBeUndefined();
	});

	it("reports when there is nothing to log out of", async () => {
		const result = await run(["logout", "token-go"]);
		expect(result.out).toBe("No stored credentials for token-go.\n");
		expect(process.exitCode).toBeUndefined();
	});

	it("reports nothing to log out for an unknown provider without credentials", async () => {
		const result = await run(["logout", "nope"]);
		expect(result.out).toBe("No stored credentials for nope.\n");
		expect(process.exitCode).toBeUndefined();
	});

	it("removes stored credentials of a hidden provider", async () => {
		await credentials.modify("hidden", async () => ({ type: "api_key", key: "k" }));
		const result = await run(["logout", "hidden"]);
		expect(result.out).toBe(`Logged out of hidden. Removed credentials from ${getAuthPath()}.\n`);
		expect(await credentials.read("hidden")).toBeUndefined();
	});

	it("rejects a --token value that looks like a flag", async () => {
		const result = await run(["login", "--token", "--offline"]);
		expect(result.err).toContain("--token requires a value.");
		expect(process.exitCode).toBe(1);
	});

	it("accepts --offline", async () => {
		const result = await run(["login", "--offline", "--token", "t"]);
		expect(process.exitCode).toBeUndefined();
		expect(result.out).toContain("Logged in to TokenGo");
	});

	describe("model refresh after login", () => {
		it("refreshes only the logged-in provider when online", async () => {
			const refresh = vi.spyOn(runtime, "refresh");
			const result = await run(["login", "--token", "t"], {});
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(refresh).toHaveBeenCalledWith({
				providers: [TOKEN_GO_PROVIDER_ID],
				allowNetwork: true,
				force: true,
				signal: expect.any(AbortSignal),
			});
			expect(process.exitCode).toBeUndefined();
			expect(result.err).toBe("");
		});

		it("warns and still succeeds when refresh throws", async () => {
			vi.spyOn(runtime, "refresh").mockRejectedValue(new Error("relay down"));
			const result = await run(["login", "--token", "t"], {});
			expect(result.err).toContain("Warning: could not refresh models for token-go: relay down");
			expect(result.out).toContain("Logged in to TokenGo as alice");
			expect(process.exitCode).toBeUndefined();
		});

		it("warns when the refresh reports an error for the provider", async () => {
			vi.spyOn(runtime, "refresh").mockResolvedValue({
				aborted: false,
				errors: new Map([[TOKEN_GO_PROVIDER_ID, new Error("pricing 500")]]),
			});
			const result = await run(["login", "--token", "t"], {});
			expect(result.err).toContain("pricing 500");
			expect(process.exitCode).toBeUndefined();
		});

		it("warns about a timeout when the refresh is aborted", async () => {
			vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: true, errors: new Map() });
			const result = await run(["login", "--token", "t"], {});
			expect(result.err).toContain("timed out");
			expect(result.out).toContain("Logged in to TokenGo as alice");
			expect(process.exitCode).toBeUndefined();
		});
	});
});
