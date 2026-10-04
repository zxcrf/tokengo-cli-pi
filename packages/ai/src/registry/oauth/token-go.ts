import { $env } from "@oh-my-pi/pi-utils/env";
import * as AIError from "../../error";
import {
	TOKEN_GO_BASE_URL,
	TOKEN_GO_CLI_GROUP,
	TOKEN_GO_PAT_ENV,
	TOKEN_GO_SUBSCRIBE_URL,
	createTokenGoClient,
	provisionTokenGoCredential,
	requireTokenGoGroup,
	tokenGoRootUrl,
} from "../../providers/token-go";
import type { OAuthController } from "./types";

/**
 * Prompt for the short-lived account PAT, then return only the durable NewAPI
 * key. The generic auth store persists this as an API-key credential; the PAT
 * is intentionally not copied into credentials or metadata.
 */
export async function loginTokenGo(options: OAuthController): Promise<string> {
	const envPat = tokenGoPatFromEnv();
	if (!options.onPrompt && !envPat) throw new AIError.OnPromptRequiredError("TokenGo");

	const baseUrl = tokenGoRootUrl($env.TOKENGO_BASE_URL?.trim() || TOKEN_GO_BASE_URL);
	options.onAuth?.({
		url: "https://token-go.click/",
		instructions: `Generate a system access token in the TokenGo console, then paste it here. A ${TOKEN_GO_CLI_GROUP} subscription is required (${TOKEN_GO_SUBSCRIBE_URL}).`,
	});
	const pat =
		envPat ??
		(
			await options.onPrompt!({
				message: "Paste your TokenGo system access token",
				placeholder: "pat-...",
				secret: true,
			})
		).trim();
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!pat) throw new AIError.ApiKeyRequiredError();

	options.onProgress?.("Checking TokenGo subscription and provisioning an API key...");
	const client = createTokenGoClient({ authToken: pat, baseUrl, fetch: options.fetch });
	const user = await client.self();
	const groups = await client.groups();
	const group = requireTokenGoGroup(groups);
	const provisioned = await provisionTokenGoCredential({ client, baseUrl, group, user });
	return provisioned.apiKey;
}

/** Synchronous env resolver used only as a PAT dashboard fallback. */
export function tokenGoPatFromEnv(): string | undefined {
	return $env[TOKEN_GO_PAT_ENV]?.trim() || undefined;
}
