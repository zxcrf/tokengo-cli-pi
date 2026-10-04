/**
 * `omp login [provider]` — the terminal counterpart of the in-session `/login`.
 *
 * Authenticates against the same credential store sessions read (local
 * `agent.db`, or the configured auth broker), including OAuth providers
 * contributed by extensions, then re-runs that provider's model discovery so
 * the next session sees the models the credential unlocked.
 */
import * as readline from "node:readline";
import {
	createTokenGoClient,
	provisionTokenGoCredential,
	requireTokenGoGroup,
	TOKEN_GO_BASE_URL,
	TOKEN_GO_BASE_URL_ENV,
	TOKEN_GO_PROVIDER_ID,
	TOKEN_GO_GROUP_ENV,
} from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai";
import { APP_NAME, getAgentDbPath, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import { formatLoginIdentity, pickOAuthProvider, promptLine, runTerminalOAuthLogin } from "./oauth-terminal";

export interface LoginCommandOptions {
	token?: string;
}

async function promptToken(rl: readline.Interface): Promise<string> {
	if (!process.stdin.isTTY) {
		throw new Error("Non-interactive login requires --token or TOKENGO_PAT");
	}
	const input = process.stdin as NodeJS.ReadStream & { setRawMode?: (enabled: boolean) => void; isRaw?: boolean };
	if (typeof input.setRawMode !== "function") return promptLine(rl, "TokenGo system access token: ");
	const deferred = Promise.withResolvers<string>();
	const wasRaw = input.isRaw ?? false;
	let value = "";
	let settled = false;
	const cleanup = () => {
		input.off("keypress", onKeypress);
		input.setRawMode?.(wasRaw);
		process.stdout.write("\n");
	};
	const finish = (result: () => void) => {
		if (settled) return;
		settled = true;
		cleanup();
		result();
	};
	const onKeypress = (text: string, key: readline.Key) => {
		if (key.name === "return" || key.name === "enter") {
			finish(() => deferred.resolve(value));
		} else if (key.name === "backspace") {
			value = value.slice(0, -1);
		} else if (key.ctrl && key.name === "c") {
			finish(() => deferred.reject(new Error("Login cancelled")));
		} else if (!key.ctrl && !key.meta && text) {
			value += text;
		}
	};
	process.stdout.write("TokenGo system access token: ");
	readline.emitKeypressEvents(input, rl);
	input.setRawMode(true);
	input.on("keypress", onKeypress);
	return deferred.promise;
}

async function runTokenGoLogin(
	authStorage: Awaited<ReturnType<typeof discoverAuthStorage>>,
	settings: Settings,
	rl: readline.Interface,
	tokenFromArgs?: string,
): Promise<void> {
	const token = tokenFromArgs?.trim() || Bun.env.TOKENGO_PAT?.trim() || (await promptToken(rl)).trim();
	if (!token) throw new Error("A TokenGo 系统访问令牌 is required");
	const baseUrl = Bun.env[TOKEN_GO_BASE_URL_ENV] || TOKEN_GO_BASE_URL;
	const client = createTokenGoClient({ pat: token, baseUrl, timeoutMs: 15_000 });
	const [user, groups] = await Promise.all([client.self(), client.groups()]);
	const group = requireTokenGoGroup(groups, Bun.env[TOKEN_GO_GROUP_ENV] || undefined);
	const credential = await provisionTokenGoCredential({ client, baseUrl, group, user });
	await authStorage.credentials.upsert(TOKEN_GO_PROVIDER_ID, {
		type: "api_key",
		key: credential.apiKey,
		source: "login",
	});

	const registry = new ModelRegistry(authStorage, undefined, { settings });
	try {
		await registry.refreshProvider(TOKEN_GO_PROVIDER_ID, "online");
	} catch (error) {
		process.stderr.write(
			`Warning: TokenGo model refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
	const models = registry.getProviderModels(TOKEN_GO_PROVIDER_ID);
	process.stdout.write(
		`Logged in to TokenGo as ${credential.metadata.username} (group ${credential.metadata.group}).\n`,
	);
	process.stdout.write(`Models: ${models.length > 0 ? models.length : "none yet (run omp models refresh)"}.\n`);
}

/**
 * Log in to `provider`, or to one picked interactively when omitted.
 *
 * An unknown/unavailable provider, a cancelled selection or prompt, and a
 * failed OAuth flow print `Login failed: …` to stderr and set exit code 1.
 */
export async function runLoginCommand(provider: string | undefined, options: LoginCommandOptions = {}): Promise<void> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const requestedProvider = provider ?? TOKEN_GO_PROVIDER_ID;
		if (requestedProvider === TOKEN_GO_PROVIDER_ID) {
			await runTokenGoLogin(authStorage, settings, rl, options.token);
			return;
		}
		const modelRegistry = new ModelRegistry(authStorage);
		// Extensions may register OAuth providers; load them so they are listed.
		await loadCliExtensionProviders(modelRegistry, settings, cwd);

		const providers = getOAuthProviders().filter(p => p.available);
		const providerId = provider ?? (await pickOAuthProvider(rl, providers));
		const info = providers.find(p => p.id === providerId);
		if (!info) {
			throw new Error(`Unknown OAuth provider '${providerId}'. Run \`${APP_NAME} login\` to pick one.`);
		}

		const identity = await runTerminalOAuthLogin(rl, authStorage, info.id, { openBrowser: true });
		if (!identity) {
			process.stdout.write(chalk.yellow(`No credentials were stored for ${info.name}.\n`));
			return;
		}
		// A provider-scoped online refresh re-runs discovery with the new
		// credential; a fresh cache row fetched before login would otherwise hide
		// the unlocked models until its TTL expires (#5780).
		await modelRegistry.refreshProvider(info.storeCredentialsAs ?? info.id, "online");

		const who = formatLoginIdentity(identity);
		process.stdout.write(chalk.green(`\nLogged in to ${info.name}${who ? ` as ${who}` : ""}\n`));
		const broker = await resolveAuthBrokerConfig();
		process.stdout.write(
			chalk.dim(
				broker ? `Credentials saved to auth broker ${broker.url}\n` : `Credentials saved to ${getAgentDbPath()}\n`,
			),
		);
	} catch (error) {
		process.stderr.write(chalk.red(`Login failed: ${error instanceof Error ? error.message : String(error)}\n`));
		process.exitCode = 1;
	} finally {
		rl.close();
		authStorage.close();
	}
}

/** Remove stored credentials for a provider. TokenGo is the default provider. */
export async function runLogoutCommand(provider = TOKEN_GO_PROVIDER_ID): Promise<void> {
	const settings = await Settings.init({ cwd: getProjectDir() });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		if (!authStorage.credentials.has(provider)) {
			process.stdout.write(`No stored credentials for ${provider}.\n`);
			return;
		}
		await authStorage.credentials.remove(provider);
		process.stdout.write(`Logged out of ${provider}.\n`);
	} catch (error) {
		process.stderr.write(chalk.red(`Logout failed: ${error instanceof Error ? error.message : String(error)}\n`));
		process.exitCode = 1;
	} finally {
		authStorage.close();
	}
}
