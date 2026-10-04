import type { ModelManagerOptions } from "../model-manager";
import { classifyModel } from "../compat/taxonomy";
import { modelLimitsFor } from "../compat/behavior";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import { resolveModelReference } from "../identity/reference";
import { getBundledModels } from "../models";
import type { Api, FetchImpl, Model, ModelSpec } from "../types";
import type { ModelManagerConfig } from "./descriptor-types";

const PROVIDER = "token-go";
const DEFAULT_BASE_URL = "https://api.token-go.click";
const NON_CHAT_MODEL_RE = /(embed|embedding|rerank|moderation|whisper|tts-|dall-e)/i;

type EndpointApi = "openai-completions" | "openai-responses" | "anthropic-messages";

function isResponsesEndpoint(value: string): boolean {
	return value === "openai-response" || value === "openai-responses" || value === "responses";
}

function isCompletionsEndpoint(value: string): boolean {
	return (
		value === "openai" ||
		value === "openai-completion" ||
		value === "openai-completions" ||
		value === "chat-completions"
	);
}

interface ModelsEnvelope {
	data?: unknown;
}

interface PricingRow {
	model_name: string;
	quota_type: number;
	model_ratio?: number;
	completion_ratio?: number;
	cache_ratio?: number;
	create_cache_ratio?: number;
	supported_endpoint_types?: string[];
}

interface PricingEnvelope {
	data?: unknown;
	group_ratio?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rootUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function inferenceUrl(baseUrl: string): string {
	return `${rootUrl(baseUrl)}/v1`;
}

function endpointApi(id: string, row: PricingRow | undefined, raw: Record<string, unknown>): EndpointApi {
	const advertised = [
		...(row?.supported_endpoint_types ?? []),
		...(Array.isArray(raw.supported_endpoint_types)
			? raw.supported_endpoint_types.filter((entry): entry is string => typeof entry === "string")
			: []),
	];
	const identity = classifyModel(PROVIDER, id, { lenient: true });
	const hasAnthropic = advertised.includes("anthropic");
	const hasResponses = advertised.some(isResponsesEndpoint);
	const hasCompletions = advertised.some(isCompletionsEndpoint);
	if (identity.class === "anthropic" && hasAnthropic) return "anthropic-messages";
	if (hasResponses && identity.class !== "anthropic") return "openai-responses";
	if (hasCompletions) return "openai-completions";
	if (hasAnthropic && identity.class === "anthropic") return "anthropic-messages";
	if (advertised.length > 0) return "openai-completions";
	// NewAPI's /v1/models payload does not always carry endpoint metadata. These
	// two families are the stable wire markers used by TokenGo's relay.
	const bare = id.toLowerCase().replace(/^.*\//, "");
	if (/^claude(?:-|$)/.test(bare)) return "anthropic-messages";
	if (/^(?:gpt|o[1-9]|codex|chatgpt)(?:-|$)/.test(bare)) return "openai-responses";
	return "openai-completions";
}

const REFERENCE_PROVIDERS_BY_API: Record<EndpointApi, readonly string[]> = {
	"anthropic-messages": ["anthropic"],
	"openai-responses": ["openai", "xai", "google", "deepseek"],
	"openai-completions": ["deepseek", "google", "xai", "openai"],
};

function referenceForModel(id: string, api: EndpointApi): Model<Api> | undefined {
	for (const provider of REFERENCE_PROVIDERS_BY_API[api]) {
		const model = getBundledModels(provider as Parameters<typeof getBundledModels>[0]).find(
			candidate => candidate.id === id,
		);
		if (model) return model;
	}
	return resolveModelReference(id, getBundledModelReferenceIndex());
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function inputModalities(value: unknown): ("text" | "image")[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const modalities = value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
	return modalities.length > 0 ? [...new Set(modalities)] : undefined;
}

function tokenGoThinking(reference: Model<Api> | undefined, api: EndpointApi): ModelSpec<Api>["thinking"] {
	if (!reference?.thinking) return undefined;
	if (api === "anthropic-messages" || reference.thinking.mode === "effort") {
		return structuredClone(reference.thinking);
	}
	// Gemini and some other canonical rows describe a native budget/level
	// control. TokenGo exposes those models through an OpenAI-compatible lane,
	// so retain the reviewed effort ladder while selecting the portable effort
	// wire mode and dropping native budget/routing fields.
	const {
		mode: _mode,
		effortMap: _effortMap,
		effortBudgets: _effortBudgets,
		effortRouting: _effortRouting,
		suppressWhenOff: _suppressWhenOff,
		...portable
	} = structuredClone(reference.thinking);
	return { ...portable, mode: "effort" };
}

function toPricing(value: unknown): PricingRow | undefined {
	if (!isRecord(value)) return undefined;
	const modelName = stringValue(value.model_name);
	const quotaType = numberValue(value.quota_type);
	if (!modelName || quotaType === undefined) return undefined;
	const endpointTypes = Array.isArray(value.supported_endpoint_types)
		? value.supported_endpoint_types.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	return {
		model_name: modelName,
		quota_type: quotaType,
		...(numberValue(value.model_ratio) !== undefined ? { model_ratio: value.model_ratio as number } : {}),
		...(numberValue(value.completion_ratio) !== undefined
			? { completion_ratio: value.completion_ratio as number }
			: {}),
		...(numberValue(value.cache_ratio) !== undefined ? { cache_ratio: value.cache_ratio as number } : {}),
		...(numberValue(value.create_cache_ratio) !== undefined
			? { create_cache_ratio: value.create_cache_ratio as number }
			: {}),
		...(endpointTypes ? { supported_endpoint_types: endpointTypes } : {}),
	};
}

async function request(fetcher: FetchImpl, url: string, apiKey: string): Promise<unknown> {
	const response = await fetcher(url, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
	});
	if (!response.ok) throw new Error(`TokenGo discovery failed (HTTP ${response.status})`);
	return response.json();
}

function cost(row: PricingRow | undefined, groupRatio: number): ModelSpec<Api>["cost"] {
	if (!row || row.quota_type !== 0 || row.model_ratio === undefined) {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}
	const input = row.model_ratio * 2 * groupRatio;
	return {
		input,
		output: input * (row.completion_ratio ?? 1),
		cacheRead: input * (row.cache_ratio ?? 1),
		cacheWrite: input * (row.create_cache_ratio ?? 1.25),
	};
}

function modelSpec(
	raw: Record<string, unknown>,
	pricing: PricingRow | undefined,
	groupRatio: number,
	baseUrl: string,
): ModelSpec<Api> | undefined {
	const id = stringValue(raw.id);
	if (!id || NON_CHAT_MODEL_RE.test(id)) return undefined;
	const advertised = [
		...(pricing?.supported_endpoint_types ?? []),
		...(Array.isArray(raw.supported_endpoint_types)
			? raw.supported_endpoint_types.filter((entry): entry is string => typeof entry === "string")
			: []),
	];
	if (
		advertised.length > 0 &&
		!advertised.some(
			endpoint => isCompletionsEndpoint(endpoint) || isResponsesEndpoint(endpoint) || endpoint === "anthropic",
		)
	) {
		return undefined;
	}
	const api = endpointApi(id, pricing, raw);
	const routeBase = api === "anthropic-messages" ? rootUrl(baseUrl) : inferenceUrl(baseUrl);
	const reference = referenceForModel(id, api);
	const name = stringValue(raw.name) ?? reference?.name ?? id;
	const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : (reference?.reasoning ?? false);
	const input = inputModalities(raw.modalities ?? raw.input) ?? reference?.input ?? ["text"];
	const contextWindow = optionalNumber(raw.context_length) ?? reference?.contextWindow ?? null;
	const maxTokens = optionalNumber(raw.max_completion_tokens) ?? reference?.maxTokens ?? null;
	const reviewedLimits = modelLimitsFor(PROVIDER, id);
	return {
		id,
		name,
		api,
		provider: PROVIDER,
		baseUrl: routeBase,
		reasoning,
		input,
		supportsTools: reference?.supportsTools ?? true,
		cost: cost(pricing, groupRatio),
		contextWindow: reviewedLimits?.context ?? contextWindow,
		maxTokens: reviewedLimits?.maxTokens ?? maxTokens,
		...(tokenGoThinking(reference, api) ? { thinking: tokenGoThinking(reference, api) } : {}),
	};
}

async function fetchTokenGoModels(config: ModelManagerConfig): Promise<readonly ModelSpec<Api>[] | null> {
	if (!config.apiKey) return null;
	const fetcher = config.fetch ?? fetch;
	const baseUrl = rootUrl(config.baseUrl ?? DEFAULT_BASE_URL);
	const modelsPayload = (await request(fetcher, `${baseUrl}/v1/models`, config.apiKey)) as ModelsEnvelope;
	if (!isRecord(modelsPayload) || !Array.isArray(modelsPayload.data)) {
		throw new Error("TokenGo /v1/models response is invalid");
	}
	const pricing = new Map<string, PricingRow>();
	let groupRatio = 1;
	// Pricing is useful metadata but not required for model availability. Some
	// deployments allow /v1 with a provisioned key while denying /api/pricing.
	try {
		// The provisioned inference key is sufficient for `/v1/models`, while
		// some relays protect `/api/pricing` with the account PAT. A PAT supplied
		// explicitly through the environment is used only for this in-memory
		// enrichment request and is never persisted.
		const pricingKey = Bun.env.TOKENGO_PAT?.trim() || config.apiKey;
		const pricingPayload = (await request(fetcher, `${baseUrl}/api/pricing`, pricingKey)) as PricingEnvelope;
		if (Array.isArray(pricingPayload.data)) {
			for (const row of pricingPayload.data
				.map(toPricing)
				.filter((entry): entry is PricingRow => entry !== undefined)) {
				pricing.set(row.model_name, row);
			}
		}
		if (isRecord(pricingPayload.group_ratio)) {
			const group = Bun.env.TOKENGO_GROUP ?? "tokengo";
			const configuredRatio = numberValue(pricingPayload.group_ratio[group]);
			if (configuredRatio !== undefined) groupRatio = configuredRatio;
		}
		// The manager receives the provisioned inference key rather than the
		// account PAT, so no account/group selector is persisted here. The
		// server's unqualified pricing card is still useful as a baseline.
	} catch {
		// The `/v1/models` result remains authoritative when pricing navigation is hidden.
	}

	const models = modelsPayload.data
		.map(value =>
			isRecord(value) ? modelSpec(value, pricing.get(stringValue(value.id) ?? ""), groupRatio, baseUrl) : undefined,
		)
		.filter((value): value is ModelSpec<Api> => value !== undefined);
	return models.length > 0 ? models : null;
}

export interface TokenGoModelManagerConfig extends ModelManagerConfig {}

export function tokenGoModelManagerOptions(config: TokenGoModelManagerConfig = {}): ModelManagerOptions<Api> {
	const baseUrl = config.baseUrl ?? Bun.env.TOKENGO_BASE_URL ?? DEFAULT_BASE_URL;
	return {
		providerId: PROVIDER,
		dynamicModelsAuthoritative: true,
		cacheProviderId: PROVIDER,
		...(config.apiKey ? { fetchDynamicModels: () => fetchTokenGoModels({ ...config, baseUrl }) } : {}),
	};
}
