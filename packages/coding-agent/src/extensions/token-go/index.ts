/**
 * TokenGo built-in extension: `/tokengo-status` shows account, group, balance, cached models and endpoint.
 * Makes no network calls at startup.
 */

import { readTokenGoCredentialEnv, TOKEN_GO_PROVIDER_ID } from "@earendil-works/pi-ai/providers/token-go";
import { createTokenGoClient, quotaToUSD, TokenGoError } from "@earendil-works/pi-ai/providers/token-go-client";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

export default function tokenGoExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tokengo-status", {
		description: "Show TokenGo account, balance and models",
		handler: async (_args, ctx) => {
			if (!ctx.modelRegistry.getProvider(TOKEN_GO_PROVIDER_ID)) {
				ctx.ui.setStatus("token-go", undefined);
				ctx.ui.notify("TokenGo provider is disabled (allowedProviders).", "warning");
				return;
			}
			const auth = await ctx.modelRegistry.getProviderAuth(TOKEN_GO_PROVIDER_ID);
			if (!auth) {
				ctx.ui.setStatus("token-go", undefined);
				ctx.ui.notify("Not logged in to TokenGo. Run `tokengo login`.", "warning");
				return;
			}
			const env = readTokenGoCredentialEnv(auth.env);
			if (!env.pat) {
				ctx.ui.setStatus("token-go", undefined);
				ctx.ui.notify("TokenGo status needs the system access token. Run `tokengo login`.", "warning");
				return;
			}
			try {
				const client = createTokenGoClient({
					pat: env.pat,
					baseUrl: env.baseUrl,
					userId: env.userId,
					signal: AbortSignal.timeout(10_000),
				});
				const user = await client.self();
				const models = ctx.modelRegistry.getAll().filter((m) => m.provider === TOKEN_GO_PROVIDER_ID).length;
				const balance = quotaToUSD(user.quota ?? 0).toFixed(2);
				const used = quotaToUSD(user.used_quota ?? 0).toFixed(2);
				const lines = [
					"TokenGo account",
					`  User:     ${user.username} (#${user.id})`,
					`  Group:    ${env.group ?? user.group ?? "unknown"}`,
					`  Balance:  $${balance} (used $${used})`,
					`  Models:   ${models} cached`,
					`  Endpoint: ${client.baseUrl}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				ctx.ui.setStatus("token-go", `TokenGo $${balance}`);
			} catch (error) {
				ctx.ui.setStatus("token-go", undefined);
				if (error instanceof TokenGoError) {
					ctx.ui.notify(error.hint ? `${error.message}\n${error.hint}` : error.message, "error");
					return;
				}
				ctx.ui.notify(`TokenGo status failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
