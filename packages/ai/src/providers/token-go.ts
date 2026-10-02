/**
 * TokenGo provider: NewAPI relay with a dynamic, persisted model catalog and
 * per-model protocol routing (Anthropic Messages / OpenAI Completions /
 * OpenAI Responses).
 */

import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { defaultProviderAuthContext } from "../auth/context.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { MODELS } from "../models.generated.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Api, Model, ModelCost, ProviderEnv } from "../types.ts";
import {
	createTokenGoClient,
	normalizeTokenGoBaseUrl,
	provisionTokenGoKey,
	requireTokenGoGroup,
	TOKEN_GO_CLI_GROUP,
	TOKEN_GO_CONSOLE_URL,
	TokenGoError,
	type TokenGoPricing,
} from "./token-go-client.ts";

export const TOKEN_GO_PROVIDER_ID = "token-go";
export const TOKEN_GO_PROVIDER_NAME = "TokenGo";
/** Verified against the relay on 2026-10-02: served to the `tokengo` group and priced at the Sonnet tier. */
export const TOKEN_GO_DEFAULT_MODEL_ID = "claude-sonnet-5";
/** Substring match, in order, when ordering the catalog and choosing a default. */
export const TOKEN_GO_MODEL_PRIORITY: readonly string[] = [
	"claude-sonnet-5",
	"claude-opus-5",
	"claude-fable-5-1",
	"gpt-5.6-terra",
	"gpt-5.5",
	"gemini-3.1-pro",
	"deepseek-flash",
	// Family fallbacks for ids the relay may add later.
	"claude-sonnet",
	"claude-opus",
	"gpt-5",
	"gemini",
	"deepseek",
];
export const TOKEN_GO_ENV = {
	apiKey: "TOKENGO_API_KEY",
	pat: "TOKENGO_PAT",
	group: "TOKENGO_GROUP",
	userId: "TOKENGO_USER_ID",
	username: "TOKENGO_USERNAME",
	baseUrl: "TOKENGO_BASE_URL",
} as const;

export type TokenGoApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface TokenGoCredentialEnv {
	pat?: string;
	group?: string;
	userId?: string;
	username?: string;
	baseUrl?: string;
}

/** Test injection. */
export interface TokenGoProviderOptions {
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function readTokenGoCredentialEnv(env: ProviderEnv | undefined): TokenGoCredentialEnv {
	return {
		pat: nonEmpty(env?.[TOKEN_GO_ENV.pat]),
		group: nonEmpty(env?.[TOKEN_GO_ENV.group]),
		userId: nonEmpty(env?.[TOKEN_GO_ENV.userId]),
		username: nonEmpty(env?.[TOKEN_GO_ENV.username]),
		baseUrl: nonEmpty(env?.[TOKEN_GO_ENV.baseUrl]),
	};
}

export function selectTokenGoApi(modelId: string, endpointTypes: readonly string[]): TokenGoApi | undefined {
	const bare = modelId.toLowerCase().replace(/^.*\//, "");
	const compat = endpointTypes.includes("openai") ? "openai-completions" : undefined;
	if (/^claude/.test(bare)) return endpointTypes.includes("anthropic") ? "anthropic-messages" : compat;
	if (/^(gpt|o[1-9]|codex|chatgpt)/.test(bare)) {
		return endpointTypes.includes("openai-response") ? "openai-responses" : compat;
	}
	return compat;
}

/** Anthropic SDK appends `/v1/messages` itself; the OpenAI SDKs expect the `/v1` root. */
export function tokenGoBaseUrlForApi(baseUrl: string, api: TokenGoApi): string {
	return api === "anthropic-messages" ? baseUrl : `${baseUrl}/v1`;
}

/** $/million tokens. Only per-token pricing (quota_type 0) is priced; per-call pricing reports zero. */
export function tokenGoModelCost(row: TokenGoPricing | undefined, groupRatio: number): ModelCost {
	if (!row || row.quota_type !== 0) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const input = (row.model_ratio ?? 0) * 2 * groupRatio;
	return {
		input,
		output: input * (row.completion_ratio ?? 1),
		cacheRead: input * (row.cache_ratio ?? 1),
		cacheWrite: input * (row.create_cache_ratio ?? 1.25),
	};
}

export function sortByTokenGoPriority<T extends { id: string }>(models: readonly T[]): T[] {
	const rank = (id: string): number => {
		const index = TOKEN_GO_MODEL_PRIORITY.findIndex((entry) => id.includes(entry));
		return index < 0 ? TOKEN_GO_MODEL_PRIORITY.length : index;
	};
	return [...models].sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const NON_CHAT_PATTERN = /(embed|rerank|moderation|whisper|tts-|dall-e)/i;
const REASONING_FALLBACK_PATTERN = /o[1-9]|gpt-5|reason|think|r1|claude-(opus|sonnet)-4|gemini-2\.5|gemini-3/;
const REFERENCE_VENDORS = ["anthropic", "openai", "google", "deepseek", "zai", "moonshotai", "xai"] as const;

type ReferenceModel = Model<Api>;

interface ReferenceEntry {
	model: ReferenceModel;
	/** Canonical vendors describe the model itself; aggregators (openrouter, together, ...) add their own routing quirks. */
	canonical: boolean;
}

interface ReferenceIndex {
	exact: Map<string, ReferenceEntry>;
	normalized: Map<string, ReferenceEntry>;
}

function normalizeReferenceId(id: string): string {
	return id
		.toLowerCase()
		.replace(/^.*\//, "")
		.replace(/(-\d{8}|-latest|-preview)+$/, "")
		.replace(/[^a-z0-9]/g, "");
}

let referenceIndex: ReferenceIndex | undefined;

function getReferenceIndex(): ReferenceIndex {
	if (referenceIndex) return referenceIndex;
	const catalogs = MODELS as Record<string, Record<string, ReferenceModel> | undefined>;
	const vendors = [
		...REFERENCE_VENDORS,
		...Object.keys(catalogs).filter((vendor) => !(REFERENCE_VENDORS as readonly string[]).includes(vendor)),
	];
	const index: ReferenceIndex = { exact: new Map(), normalized: new Map() };
	for (const vendor of vendors) {
		const canonical = (REFERENCE_VENDORS as readonly string[]).includes(vendor);
		for (const model of Object.values(catalogs[vendor] ?? {})) {
			const entry: ReferenceEntry = { model, canonical };
			if (!index.exact.has(model.id)) index.exact.set(model.id, entry);
			const key = normalizeReferenceId(model.id);
			if (!index.normalized.has(key)) index.normalized.set(key, entry);
		}
	}
	referenceIndex = index;
	return index;
}

function buildTokenGoModel(
	id: string,
	api: TokenGoApi,
	baseUrl: string,
	cost: ModelCost,
	entry: ReferenceEntry | undefined,
): Model<TokenGoApi> {
	const ref = entry?.model;
	const canonical = entry?.canonical === true;
	const model: Model<TokenGoApi> = {
		id,
		name: ref && canonical ? ref.name.replace(/\s*\(latest\)\s*$/i, "") : id,
		api,
		provider: TOKEN_GO_PROVIDER_ID,
		baseUrl: tokenGoBaseUrlForApi(baseUrl, api),
		reasoning: ref ? ref.reasoning : REASONING_FALLBACK_PATTERN.test(id.toLowerCase()),
		input: ref ? [...ref.input] : ["text"],
		cost,
		contextWindow: ref ? ref.contextWindow : 128000,
		maxTokens: ref ? ref.maxTokens : 32000,
	};
	// Aggregator metadata carries thinking formats and session-affinity headers meant for their own gateways.
	if (!ref || !canonical) return model;
	if (ref.inputLimits) model.inputLimits = structuredClone(ref.inputLimits);
	if ((ref.api as string) === api) {
		if (ref.thinkingLevelMap) model.thinkingLevelMap = structuredClone(ref.thinkingLevelMap);
		if (ref.promptCache) model.promptCache = structuredClone(ref.promptCache);
		if (ref.compat) {
			// compat is typed per api; the api equality above makes this copy safe.
			const compat = structuredClone(ref.compat) as Record<string, unknown>;
			// Points at models of providers that are not part of this catalog.
			delete compat.allowedFallbackModels;
			model.compat = compat as Model<TokenGoApi>["compat"];
		}
	}
	return model;
}

export function buildTokenGoModels(input: {
	names: readonly string[];
	pricing: readonly TokenGoPricing[];
	groupRatio: number;
	baseUrl: string;
}): Model<TokenGoApi>[] {
	const rows = new Map(input.pricing.map((row) => [row.model_name, row]));
	const index = getReferenceIndex();
	const models: Model<TokenGoApi>[] = [];
	for (const id of new Set(input.names)) {
		if (NON_CHAT_PATTERN.test(id)) continue;
		const row = rows.get(id);
		const api = selectTokenGoApi(id, row?.supported_endpoint_types ?? ["openai"]);
		if (!api) continue;
		const entry = index.exact.get(id) ?? index.normalized.get(normalizeReferenceId(id));
		models.push(buildTokenGoModel(id, api, input.baseUrl, tokenGoModelCost(row, input.groupRatio), entry));
	}
	return sortByTokenGoPriority(models);
}

export function tokenGoApiKeyAuth(options?: TokenGoProviderOptions): ApiKeyAuth {
	return {
		name: "TokenGo system access token",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const baseUrl = normalizeTokenGoBaseUrl(
				options?.baseUrl ?? (await defaultProviderAuthContext().env(TOKEN_GO_ENV.baseUrl)),
			);
			interaction.notify({
				type: "info",
				message: "Generate a 系统访问令牌 in the TokenGo console (个人设置).",
				links: [{ url: TOKEN_GO_CONSOLE_URL, label: "TokenGo console" }],
			});
			const pat = (await interaction.prompt({ type: "secret", message: "Paste your TokenGo 系统访问令牌" })).trim();
			interaction.signal.throwIfAborted();
			if (!pat) throw new Error("A TokenGo 系统访问令牌 is required");
			interaction.notify({ type: "progress", message: "Validating token…" });
			const client = createTokenGoClient({
				pat,
				baseUrl,
				fetch: options?.fetch,
				signal: interaction.signal,
				timeoutMs: 15_000,
			});
			const [user, groups] = await Promise.all([client.self(), client.groups()]);
			const group = requireTokenGoGroup(groups);
			const provisioned = await provisionTokenGoKey({ client, group, user });
			return {
				type: "api_key",
				key: provisioned.key,
				env: {
					[TOKEN_GO_ENV.pat]: pat,
					[TOKEN_GO_ENV.group]: group,
					[TOKEN_GO_ENV.userId]: String(user.id),
					[TOKEN_GO_ENV.username]: user.username,
					[TOKEN_GO_ENV.baseUrl]: baseUrl,
				},
			};
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}
			const key = (await ctx.env(TOKEN_GO_ENV.apiKey))?.trim();
			signal.throwIfAborted();
			if (!key) return undefined;
			const env: ProviderEnv = {};
			for (const name of [TOKEN_GO_ENV.pat, TOKEN_GO_ENV.baseUrl, TOKEN_GO_ENV.group, TOKEN_GO_ENV.userId]) {
				const value = await ctx.env(name);
				if (value) env[name] = value;
			}
			signal.throwIfAborted();
			return { auth: { apiKey: key }, env, source: TOKEN_GO_ENV.apiKey };
		},
	};
}

/** Throws on failure so createProvider keeps the previous catalog; an empty list would be persisted. */
export async function fetchTokenGoModels(
	context: RefreshModelsContext,
	options?: TokenGoProviderOptions,
): Promise<Model<TokenGoApi>[]> {
	const env = readTokenGoCredentialEnv(context.credential?.type === "api_key" ? context.credential.env : undefined);
	if (!env.pat) {
		throw new TokenGoError("TokenGo model discovery needs the system access token; run `tokengo login`", {
			path: "/api/user/models",
		});
	}
	const baseUrl = normalizeTokenGoBaseUrl(env.baseUrl ?? options?.baseUrl);
	const group = env.group ?? TOKEN_GO_CLI_GROUP;
	const client = createTokenGoClient({
		pat: env.pat,
		baseUrl,
		userId: env.userId,
		fetch: options?.fetch,
		signal: context.signal,
		timeoutMs: 8_000,
	});
	const [names, pricing] = await Promise.allSettled([client.userModels(group), client.pricingEnvelope()]);
	if (names.status === "rejected") throw names.reason;
	let envelope: { data: TokenGoPricing[]; group_ratio: Record<string, number> } = { data: [], group_ratio: {} };
	if (pricing.status === "fulfilled") {
		envelope = pricing.value;
	} else if (
		// Pricing can be hidden from the token: models stay usable with zero cost. Anything else keeps the old catalog.
		!(pricing.reason instanceof TokenGoError && [401, 403, 404].includes(pricing.reason.status ?? 0))
	) {
		throw pricing.reason;
	}
	return buildTokenGoModels({
		names: names.value,
		pricing: envelope.data,
		groupRatio: envelope.group_ratio[group] ?? 1,
		baseUrl,
	});
}

export function tokenGoProvider(options?: TokenGoProviderOptions): Provider<TokenGoApi> {
	return createProvider<TokenGoApi>({
		id: TOKEN_GO_PROVIDER_ID,
		name: TOKEN_GO_PROVIDER_NAME,
		auth: { apiKey: tokenGoApiKeyAuth(options) },
		models: [],
		fetchModels: (context) => fetchTokenGoModels(context, options),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
