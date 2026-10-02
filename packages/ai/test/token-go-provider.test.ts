import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type {
	ApiKeyCredential,
	AuthContext,
	AuthEvent,
	AuthPrompt,
	ProviderAuthInteraction,
} from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { builtinProviders } from "../src/providers/all.ts";
import {
	fetchTokenGoModels,
	readTokenGoCredentialEnv,
	TOKEN_GO_ENV,
	TOKEN_GO_PROVIDER_ID,
	tokenGoProvider,
} from "../src/providers/token-go.ts";
import {
	TOKEN_GO_AUTH_HINT,
	TOKEN_GO_SUBSCRIBE_URL,
	TOKEN_GO_TOKEN_NAME,
	TokenGoError,
} from "../src/providers/token-go-client.ts";
import { type FakeTokenGo, startFakeTokenGo } from "./helpers/token-go-server.ts";

function scriptedInteraction(secret: string, signal = new AbortController().signal) {
	const prompts: AuthPrompt[] = [];
	const events: AuthEvent[] = [];
	const interaction: ProviderAuthInteraction = {
		signal,
		prompt: async (prompt) => {
			prompts.push(prompt);
			return secret;
		},
		notify: (event) => {
			events.push(event);
		},
	};
	return { interaction, prompts, events };
}

/** Never answers; rejects with the signal reason on abort. */
const hangingFetch: typeof globalThis.fetch = (_input, init) =>
	new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	});

function envContext(values: Record<string, string>): AuthContext {
	return {
		env: async (name) => values[name],
		fileExists: async () => false,
	};
}

function storedCredential(fake: FakeTokenGo, overrides: Record<string, string> = {}): ApiKeyCredential {
	return {
		type: "api_key",
		key: "sk-fake-1",
		env: {
			[TOKEN_GO_ENV.pat]: fake.pat,
			[TOKEN_GO_ENV.group]: "tokengo",
			[TOKEN_GO_ENV.userId]: "7",
			[TOKEN_GO_ENV.username]: "alice",
			[TOKEN_GO_ENV.baseUrl]: fake.url,
			...overrides,
		},
	};
}

describe("token-go provider", () => {
	let fake: FakeTokenGo;

	beforeEach(async () => {
		fake = await startFakeTokenGo();
	});

	afterEach(async () => {
		await fake.close();
	});

	it("is registered as a builtin provider with no static models", () => {
		const provider = builtinProviders().find((entry) => entry.id === TOKEN_GO_PROVIDER_ID);
		expect(provider?.name).toBe("TokenGo");
		expect(provider?.getModels()).toEqual([]);
	});

	describe("login", () => {
		it("prompts for the PAT, provisions the cli token and returns the credential", async () => {
			const provider = tokenGoProvider({ baseUrl: fake.url });
			const { interaction, prompts, events } = scriptedInteraction(`  ${fake.pat}  `);
			const credential = await provider.auth.apiKey?.login?.(interaction);

			expect(prompts).toHaveLength(1);
			expect(prompts[0].type).toBe("secret");
			expect(events.map((event) => event.type)).toEqual(["info", "progress"]);
			expect(fake.tokens).toEqual([{ id: 1, name: TOKEN_GO_TOKEN_NAME, group: "tokengo", status: 1 }]);
			expect(credential).toEqual({
				type: "api_key",
				key: "sk-fake-1",
				env: {
					TOKENGO_PAT: fake.pat,
					TOKENGO_GROUP: "tokengo",
					TOKENGO_USER_ID: "7",
					TOKENGO_USERNAME: "alice",
					TOKENGO_BASE_URL: fake.url,
				},
			});
		});

		it("reuses the existing token on re-login", async () => {
			const provider = tokenGoProvider({ baseUrl: fake.url });
			await provider.auth.apiKey?.login?.(scriptedInteraction(fake.pat).interaction);
			await provider.auth.apiKey?.login?.(scriptedInteraction(fake.pat).interaction);
			expect(fake.tokens).toHaveLength(1);
		});

		it("points at the subscription page when the tokengo group is missing", async () => {
			const noGroup = await startFakeTokenGo({ groups: { default: { ratio: 1 } } });
			try {
				const provider = tokenGoProvider({ baseUrl: noGroup.url });
				const error = await provider.auth.apiKey
					?.login?.(scriptedInteraction(noGroup.pat).interaction)
					.catch((e) => e);
				expect(error).toBeInstanceOf(TokenGoError);
				expect((error as Error).message).toContain(TOKEN_GO_SUBSCRIBE_URL);
				expect(noGroup.tokens).toEqual([]);
			} finally {
				await noGroup.close();
			}
		});

		it("rejects an empty token before any request", async () => {
			const provider = tokenGoProvider({ baseUrl: fake.url });
			await expect(provider.auth.apiKey?.login?.(scriptedInteraction("   ").interaction)).rejects.toThrow(
				"A TokenGo 系统访问令牌 is required",
			);
			expect(fake.calls).toEqual([]);
		});

		it("surfaces the auth hint for a rejected token", async () => {
			const provider = tokenGoProvider({ baseUrl: fake.url });
			const error = await provider.auth.apiKey
				?.login?.(scriptedInteraction("wrong-pat").interaction)
				.catch((e) => e);
			expect((error as TokenGoError).hint).toBe(TOKEN_GO_AUTH_HINT);
			expect((error as Error).message).not.toContain("wrong-pat");
		});

		it("does not send New-Api-User during login", async () => {
			const provider = tokenGoProvider({ baseUrl: fake.url });
			await provider.auth.apiKey?.login?.(scriptedInteraction(fake.pat).interaction);
			expect(fake.requests.length).toBeGreaterThan(0);
			for (const request of fake.requests) expect(request.headers["new-api-user"]).toBeUndefined();
		});

		it("aborts an in-flight login request with the interaction signal", async () => {
			const controller = new AbortController();
			const reason = new Error("login cancelled");
			const provider = tokenGoProvider({ baseUrl: fake.url, fetch: hangingFetch });
			const pending = provider.auth.apiKey?.login?.(scriptedInteraction(fake.pat, controller.signal).interaction);
			const outcome = pending?.catch((error: unknown) => error);
			setTimeout(() => controller.abort(reason), 10);
			expect(await outcome).toBe(reason);
		});

		it("honors an already aborted signal", async () => {
			const controller = new AbortController();
			controller.abort(new Error("stop"));
			const provider = tokenGoProvider({ baseUrl: fake.url });
			await expect(
				provider.auth.apiKey?.login?.(scriptedInteraction(fake.pat, controller.signal).interaction),
			).rejects.toThrow("stop");
		});
	});

	describe("resolve", () => {
		const signal = new AbortController().signal;

		it("uses the stored credential key and env", async () => {
			const provider = tokenGoProvider();
			const credential = storedCredential(fake);
			const result = await provider.auth.apiKey?.resolve({
				ctx: envContext({ TOKENGO_API_KEY: "ignored" }),
				credential,
				signal,
			});
			expect(result).toEqual({ auth: { apiKey: "sk-fake-1" }, env: credential.env, source: "stored credential" });
			expect(result?.auth.baseUrl).toBeUndefined();
		});

		it("falls back to TOKENGO_API_KEY with present-only PAT, base url and group", async () => {
			const provider = tokenGoProvider();
			const result = await provider.auth.apiKey?.resolve({
				ctx: envContext({ TOKENGO_API_KEY: "sk-env", TOKENGO_PAT: "pat-env", TOKENGO_BASE_URL: "http://x.test" }),
				signal,
			});
			expect(result).toEqual({
				auth: { apiKey: "sk-env" },
				env: { TOKENGO_PAT: "pat-env", TOKENGO_BASE_URL: "http://x.test" },
				source: "TOKENGO_API_KEY",
			});
		});

		it("trims the key and forwards the user id for headless discovery", async () => {
			const provider = tokenGoProvider();
			const result = await provider.auth.apiKey?.resolve({
				ctx: envContext({ TOKENGO_API_KEY: "  sk-env  ", TOKENGO_PAT: "p", TOKENGO_USER_ID: "7" }),
				signal,
			});
			expect(result?.auth.apiKey).toBe("sk-env");
			expect(result?.env).toEqual({ TOKENGO_PAT: "p", TOKENGO_USER_ID: "7" });
		});

		it("returns undefined when nothing is configured", async () => {
			const provider = tokenGoProvider();
			expect(await provider.auth.apiKey?.resolve({ ctx: envContext({}), signal })).toBeUndefined();
		});
	});

	describe("readTokenGoCredentialEnv", () => {
		it("maps and trims credential env", () => {
			expect(readTokenGoCredentialEnv({ TOKENGO_PAT: " p ", TOKENGO_USER_ID: "7", TOKENGO_GROUP: " " })).toEqual({
				pat: "p",
				group: undefined,
				userId: "7",
				username: undefined,
				baseUrl: undefined,
			});
			expect(readTokenGoCredentialEnv(undefined).pat).toBeUndefined();
		});
	});

	describe("model discovery", () => {
		async function modelsWithLogin(options?: { store?: InMemoryModelsStore; credential?: ApiKeyCredential }) {
			const credentials = new InMemoryCredentialStore();
			await credentials.modify(TOKEN_GO_PROVIDER_ID, async () => options?.credential ?? storedCredential(fake));
			const modelsStore = options?.store ?? new InMemoryModelsStore();
			const models = createModels({ credentials, modelsStore });
			models.setProvider(tokenGoProvider({ baseUrl: fake.url }));
			return { models, credentials, modelsStore };
		}

		it("publishes routed, priced, ordered models through Models.refresh", async () => {
			const { models, modelsStore } = await modelsWithLogin();
			const result = await models.refresh({ providers: [TOKEN_GO_PROVIDER_ID], allowNetwork: true });
			expect(result.errors.size).toBe(0);

			const listed = models.getModels(TOKEN_GO_PROVIDER_ID);
			expect(listed.map((model) => model.id)).toEqual([
				"claude-sonnet-4-5",
				"gpt-5",
				"deepseek-chat",
				"claude-haiku-4-5",
			]);
			const byId = new Map(listed.map((model) => [model.id, model]));
			expect(byId.get("claude-sonnet-4-5")).toMatchObject({ api: "anthropic-messages", baseUrl: fake.url });
			expect(byId.get("claude-haiku-4-5")).toMatchObject({ api: "anthropic-messages", baseUrl: fake.url });
			expect(byId.get("gpt-5")).toMatchObject({ api: "openai-responses", baseUrl: `${fake.url}/v1` });
			expect(byId.get("deepseek-chat")).toMatchObject({ api: "openai-completions", baseUrl: `${fake.url}/v1` });
			expect(byId.get("claude-sonnet-4-5")?.cost.input).toBeCloseTo(1.5 * 2 * 0.8);
			expect(listed.some((model) => model.id.includes("embedding"))).toBe(false);

			const stored = await modelsStore.read(TOKEN_GO_PROVIDER_ID);
			expect(stored?.models.map((model) => model.id)).toEqual(listed.map((model) => model.id));
			expect(fake.calls).toContain("GET /api/user/models?group=tokengo");
			for (const request of fake.requests) expect(request.headers["new-api-user"]).toBe("7");
		});

		it("falls back to completions and zero cost when pricing is hidden", async () => {
			for (const status of [401, 403] as const) {
				const hidden = await startFakeTokenGo({ pricingStatus: status });
				try {
					const models = await fetchTokenGoModels({
						credential: storedCredential(hidden),
						allowNetwork: true,
						signal: new AbortController().signal,
						publish: async () => true,
					});
					expect(models.map((model) => model.id)).toContain("claude-sonnet-4-5");
					for (const model of models) {
						expect(model.api).toBe("openai-completions");
						expect(model.baseUrl).toBe(`${hidden.url}/v1`);
						expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
					}
				} finally {
					await hidden.close();
				}
			}
		});

		it("treats a pricing 404 like hidden pricing", async () => {
			const missing = await startFakeTokenGo({ pricingStatus: 404 });
			try {
				const models = await fetchTokenGoModels({
					credential: storedCredential(missing),
					allowNetwork: true,
					signal: new AbortController().signal,
					publish: async () => true,
				});
				expect(models.length).toBeGreaterThan(0);
				for (const model of models) expect(model.cost.input).toBe(0);
			} finally {
				await missing.close();
			}
		});

		it("throws on pricing 500 and keeps the prior catalog", async () => {
			const good = await modelsWithLogin();
			await good.models.refresh({ providers: [TOKEN_GO_PROVIDER_ID], allowNetwork: true });
			const before = good.models.getModels(TOKEN_GO_PROVIDER_ID).map((model) => model.id);
			const broken = await startFakeTokenGo({ pricingStatus: 500 });
			try {
				await good.credentials.modify(TOKEN_GO_PROVIDER_ID, async () =>
					storedCredential(broken, { TOKENGO_BASE_URL: broken.url }),
				);
				good.models.setProvider(tokenGoProvider({ baseUrl: broken.url }));
				const result = await good.models.refresh({ providers: [TOKEN_GO_PROVIDER_ID], allowNetwork: true });
				expect((result.errors.get(TOKEN_GO_PROVIDER_ID) as TokenGoError).status).toBe(500);
				expect((await good.modelsStore.read(TOKEN_GO_PROVIDER_ID))?.models.map((model) => model.id)).toEqual(
					before,
				);
			} finally {
				await broken.close();
			}
		});

		it("throws when the pricing request times out or fails at the network", async () => {
			const failingPricing: typeof globalThis.fetch = (input, init) => {
				if (String(input).includes("/api/pricing"))
					return Promise.reject(new DOMException("timed out", "TimeoutError"));
				return fetch(input, init);
			};
			const error = await fetchTokenGoModels(
				{
					credential: storedCredential(fake),
					allowNetwork: true,
					signal: new AbortController().signal,
					publish: async () => true,
				},
				{ fetch: failingPricing },
			).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(TokenGoError);
			expect((error as TokenGoError).status).toBeUndefined();
		});

		it("aborts discovery with the context signal", async () => {
			const controller = new AbortController();
			const reason = new Error("refresh cancelled");
			const pending = fetchTokenGoModels(
				{
					credential: storedCredential(fake),
					allowNetwork: true,
					signal: controller.signal,
					publish: async () => true,
				},
				{ fetch: hangingFetch },
			).catch((e: unknown) => e);
			setTimeout(() => controller.abort(reason), 10);
			expect(await pending).toBe(reason);
		});

		it("restores the persisted catalog without network access", async () => {
			const first = await modelsWithLogin();
			await first.models.refresh({ providers: [TOKEN_GO_PROVIDER_ID], allowNetwork: true });
			const expected = first.models.getModels(TOKEN_GO_PROVIDER_ID).map((model) => model.id);
			const callsBefore = fake.calls.length;

			const second = await modelsWithLogin({ store: first.modelsStore });
			expect(second.models.getModels(TOKEN_GO_PROVIDER_ID)).toEqual([]);
			await second.models.refresh({ providers: [TOKEN_GO_PROVIDER_ID], allowNetwork: false });
			expect(second.models.getModels(TOKEN_GO_PROVIDER_ID).map((model) => model.id)).toEqual(expected);
			expect(fake.calls).toHaveLength(callsBefore);
		});

		it("throws on failure and keeps the previous catalog", async () => {
			const good = await modelsWithLogin();
			await good.models.refresh({ providers: [TOKEN_GO_PROVIDER_ID], allowNetwork: true });
			const before = good.models.getModels(TOKEN_GO_PROVIDER_ID).map((model) => model.id);
			expect(before.length).toBeGreaterThan(0);

			await good.credentials.modify(TOKEN_GO_PROVIDER_ID, async () =>
				storedCredential(fake, { TOKENGO_PAT: "bad-pat" }),
			);
			const result = await good.models.refresh({ providers: [TOKEN_GO_PROVIDER_ID], allowNetwork: true });
			const error = result.errors.get(TOKEN_GO_PROVIDER_ID);
			expect(error).toBeInstanceOf(TokenGoError);
			expect((error as TokenGoError).hint).toBe(TOKEN_GO_AUTH_HINT);
			expect(good.models.getModels(TOKEN_GO_PROVIDER_ID).map((model) => model.id)).toEqual(before);
			expect((await good.modelsStore.read(TOKEN_GO_PROVIDER_ID))?.models.map((model) => model.id)).toEqual(before);
		});

		it("needs the PAT in the credential env", async () => {
			const context = {
				credential: { type: "api_key" as const, key: "sk-fake-1" },
				allowNetwork: true,
				signal: new AbortController().signal,
				publish: async () => true,
			};
			await expect(fetchTokenGoModels(context, { baseUrl: fake.url })).rejects.toThrow("system access token");
			expect(fake.calls).toEqual([]);
		});

		it("discovers headlessly from TOKENGO_API_KEY and TOKENGO_PAT", async () => {
			const models = createModels({
				authContext: envContext({
					TOKENGO_API_KEY: "sk-fake-1",
					TOKENGO_PAT: fake.pat,
					TOKENGO_BASE_URL: fake.url,
				}),
			});
			models.setProvider(tokenGoProvider());
			const result = await models.refresh({ providers: [TOKEN_GO_PROVIDER_ID], allowNetwork: true });
			expect(result.errors.size).toBe(0);
			expect(models.getModels(TOKEN_GO_PROVIDER_ID).map((model) => model.id)).toContain("claude-sonnet-4-5");
		});
	});
});
