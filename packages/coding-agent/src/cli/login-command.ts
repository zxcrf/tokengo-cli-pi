import type { AuthType, Credential, Provider } from "@earendil-works/pi-ai";
import { TOKEN_GO_ENV, TOKEN_GO_PROVIDER_ID } from "@earendil-works/pi-ai/providers/token-go";
import { APP_NAME, getAuthPath } from "../config.ts";
import { defaultModelPerProvider } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	createTerminalAuthInteraction,
	type TerminalAuthInput,
	type TerminalAuthOutput,
} from "./terminal-auth-interaction.ts";

export interface LoginCommandOptions {
	settingsManager: SettingsManager;
	/** Tests inject a runtime; otherwise one is created with the settings' provider allow-list. */
	modelRuntime?: ModelRuntime;
	input?: TerminalAuthInput;
	output?: TerminalAuthOutput;
	errorOutput?: TerminalAuthOutput;
	env?: Record<string, string | undefined>;
}

const CANCELLED_MESSAGE = "Login cancelled";

function usage(): string {
	return `Usage:
  ${APP_NAME} login [provider] [--token <pat>]
  ${APP_NAME} logout [provider]

Logs in to (or out of) a provider without starting the TUI. The default provider is ${TOKEN_GO_PROVIDER_ID}.
--token supplies the secret non-interactively. For ${TOKEN_GO_PROVIDER_ID}, the TOKENGO_PAT environment variable is used when --token is absent.
Exit codes: 0 success, 1 failure, 130 cancelled.
`;
}

interface ParsedArgs {
	provider: string;
	token: string | undefined;
	help: boolean;
	error: string | undefined;
}

function parseArgs(command: "login" | "logout", args: string[]): ParsedArgs {
	const parsed: ParsedArgs = { provider: TOKEN_GO_PROVIDER_ID, token: undefined, help: false, error: undefined };
	let providerSeen = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-h" || arg === "--help") {
			parsed.help = true;
		} else if (arg === "--offline") {
			// Handled globally by the main entry point.
		} else if (command === "login" && (arg === "--token" || arg.startsWith("--token="))) {
			const value = arg === "--token" ? args[++i] : arg.slice("--token=".length);
			if (value === undefined || value === "" || value.startsWith("-")) parsed.error = "--token requires a value.";
			else parsed.token = value;
		} else if (arg.startsWith("-")) {
			parsed.error = `Unknown option: ${arg.split("=")[0]}`;
		} else if (providerSeen) {
			parsed.error = "Unexpected argument.";
		} else {
			providerSeen = true;
			parsed.provider = arg;
		}
	}
	return parsed;
}

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const hint = typeof error === "object" && error !== null ? (error as { hint?: unknown }).hint : undefined;
	return typeof hint === "string" && hint.length > 0 && !message.includes(hint) ? `${message}\n${hint}` : message;
}

function isCancelled(error: unknown): boolean {
	if (error instanceof Error) return error.message === CANCELLED_MESSAGE || error.name === "AbortError";
	return false;
}

function pickAuthType(provider: Provider): AuthType | undefined {
	if (provider.auth.apiKey?.login) return "api_key";
	if (provider.auth.oauth) return "oauth";
	return undefined;
}

function loggedInLine(provider: Provider, credential: Credential): string {
	if (provider.id === TOKEN_GO_PROVIDER_ID && credential.type === "api_key") {
		const username = credential.env?.[TOKEN_GO_ENV.username];
		const group = credential.env?.[TOKEN_GO_ENV.group];
		if (username) return `Logged in to ${provider.name} as ${username}${group ? ` (group ${group})` : ""}.`;
	}
	return `Logged in to ${provider.name}.`;
}

/** Handles `login` and `logout`. Returns false unless args[0] is one of them. Sets process.exitCode. */
export async function runLoginCommand(args: string[], options: LoginCommandOptions): Promise<boolean> {
	const command = args[0];
	if (command !== "login" && command !== "logout") return false;

	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const errorOutput = options.errorOutput ?? process.stderr;
	const env = options.env ?? process.env;
	const fail = (message: string, code = 1): true => {
		errorOutput.write(`${message}\n`);
		process.exitCode = code;
		return true;
	};

	const parsed = parseArgs(command, args.slice(1));
	if (parsed.help) {
		output.write(usage());
		return true;
	}
	if (parsed.error) return fail(`${parsed.error}\n\n${usage()}`);

	try {
		const runtime =
			options.modelRuntime ??
			(await ModelRuntime.create({
				allowModelNetwork: false,
				allowedBuiltinProviders: options.settingsManager.getAllowedProviders(),
			}));
		const providers = runtime.getProviders();
		const provider = providers.find((entry) => entry.id === parsed.provider);

		if (command === "logout") {
			// Credentials of a hidden provider can still be removed.
			const stored = await runtime.listCredentials();
			if (!stored.some((entry) => entry.providerId === parsed.provider)) {
				output.write(`No stored credentials for ${parsed.provider}.\n`);
				return true;
			}
			await runtime.logout(parsed.provider);
			output.write(
				`Logged out of ${provider?.name ?? parsed.provider}. Removed credentials from ${getAuthPath()}.\n`,
			);
			return true;
		}

		if (!provider) {
			return fail(
				`Unknown or disabled provider "${parsed.provider}". Enabled: ${providers.map((entry) => entry.id).join(", ")}`,
			);
		}

		const method = pickAuthType(provider);
		if (!method) return fail(`Provider "${provider.id}" does not support ${APP_NAME} login.`);

		const presetSecret = parsed.token ?? (provider.id === TOKEN_GO_PROVIDER_ID ? env.TOKENGO_PAT : undefined);
		const interaction = createTerminalAuthInteraction({
			input,
			output: errorOutput,
			presetSecret: presetSecret || undefined,
		});
		const credential = await runtime.login(provider.id, method, interaction, {
			getDeviceId: () => options.settingsManager.getOrCreateDeviceId(),
		});

		let warning: string | undefined;
		if (env.PI_OFFLINE === undefined) {
			try {
				const result = await runtime.refresh({
					providers: [provider.id],
					allowNetwork: true,
					force: true,
					signal: AbortSignal.timeout(15_000),
				});
				const refreshError = result.errors.get(provider.id);
				if (refreshError) warning = errorText(refreshError);
				else if (result.aborted) warning = "model refresh timed out.";
			} catch (error) {
				warning = errorText(error);
			}
		}
		if (warning) errorOutput.write(`Warning: could not refresh models for ${provider.id}: ${warning}\n`);

		const models = runtime.getModels(provider.id);
		output.write(`${loggedInLine(provider, credential)}\n`);
		output.write(`Credentials saved to ${getAuthPath()}\n`);
		if (models.length === 0) {
			output.write(`Models: none yet (run ${APP_NAME} with network access to refresh).\n`);
		} else {
			const preferredId = (defaultModelPerProvider as Partial<Record<string, string>>)[provider.id];
			const preferred = models.find((model) => model.id === preferredId) ?? models[0];
			output.write(`Models: ${models.length} available. Suggested default: ${preferred.provider}/${preferred.id}\n`);
		}
		return true;
	} catch (error) {
		if (isCancelled(error)) return fail(CANCELLED_MESSAGE, 130);
		return fail(errorText(error));
	}
}
