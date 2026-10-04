/**
 * TokenGo account API client and model discovery primitives.
 *
 * TokenGo exposes two credentials with different scopes: a personal access
 * token (PAT) for the account API and a regular NewAPI key for `/v1`. The
 * client deliberately keeps the two concepts separate. A caller may use a
 * PAT to discover/provision a key, then pass the provisioned key to the
 * regular OpenAI/Anthropic transports.
 */

import type { FetchImpl } from "../types";

export const TOKEN_GO_PROVIDER_ID = "token-go";
export const TOKEN_GO_BASE_URL = "https://api.token-go.click";
export const TOKEN_GO_CLI_GROUP = "tokengo";
export const TOKEN_GO_SUBSCRIBE_URL = "https://token-go.click/wallet";
export const TOKEN_GO_TOKEN_NAME = "tokengo-cli";
export const TOKEN_GO_PAT_ENV = "TOKENGO_PAT";
export const TOKEN_GO_API_KEY_ENV = "TOKENGO_API_KEY";
export const TOKEN_GO_BASE_URL_ENV = "TOKENGO_BASE_URL";
export const TOKEN_GO_GROUP_ENV = "TOKENGO_GROUP";

const TOKEN_ENABLED = 1;
const TOKEN_PAGE_SIZE = 100;
const MAX_TOKEN_PAGES = 50;
const QUOTA_PER_USD = 500_000;

export type TokenGoFetch = FetchImpl;

export interface TokenGoUser {
	id: number;
	username: string;
	display_name?: string;
	group?: string;
	quota?: number;
	used_quota?: number;
}

export interface TokenGoGroup {
	/** The `auto` group may report a localized string rather than a number. */
	ratio: number | string;
	desc?: string;
}

export interface TokenGoPricing {
	model_name: string;
	quota_type: number;
	model_ratio?: number;
	model_price?: number;
	completion_ratio?: number;
	cache_ratio?: number;
	create_cache_ratio?: number;
	enable_groups?: string[];
	supported_endpoint_types?: string[];
	owner_by?: string;
	description?: string;
	tags?: string;
}

export interface TokenGoPricingEnvelope {
	data: TokenGoPricing[];
	group_ratio: Record<string, number>;
}

export interface TokenGoToken {
	id: number;
	name: string;
	key?: string;
	group?: string;
	status: number;
	unlimited_quota?: boolean;
	remain_quota?: number;
	expired_time?: number;
}

export interface TokenGoModelEndpoint {
	id: string;
	api: "openai-completions" | "openai-responses" | "anthropic-messages";
	baseUrl: string;
	pricing?: TokenGoPricing;
}

export interface TokenGoCreateToken {
	name: string;
	group: string;
	unlimited_quota: boolean;
	remain_quota: number;
	expired_time: number;
	model_limits_enabled: boolean;
	model_limits: string;
	allow_ips: string;
}

export interface TokenGoClient {
	self(): Promise<TokenGoUser>;
	groups(): Promise<Record<string, TokenGoGroup>>;
	userModels(group: string): Promise<string[]>;
	/** NewAPI `/v1/models` rows, when the deployment exposes that endpoint. */
	openAiModels(): Promise<readonly Record<string, unknown>[]>;
	pricing(): Promise<TokenGoPricing[]>;
	pricingEnvelope(): Promise<TokenGoPricingEnvelope>;
	tokens(): Promise<TokenGoToken[]>;
	createToken(body: TokenGoCreateToken): Promise<void>;
	tokenKey(id: number): Promise<string>;
}

export interface TokenGoClientOptions {
	baseUrl?: string;
	/** Bearer used for either account (PAT) or NewAPI (`sk-`) endpoints. */
	authToken?: string;
	/** @deprecated Use authToken; retained so callers can name the account credential explicitly. */
	pat?: string;
	fetch?: TokenGoFetch;
	timeoutMs?: number;
}

interface TokenGoEnvelope {
	success: boolean;
	message?: string;
	data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function requiredNumber(value: unknown, field: string): number {
	const number = asNumber(value);
	if (number === undefined) throw new Error(`TokenGo response field ${field} is invalid`);
	return number;
}

function requiredString(value: unknown, field: string): string {
	const string = asString(value);
	if (!string) throw new Error(`TokenGo response field ${field} is invalid`);
	return string;
}

function optionalNumber(value: unknown): number | undefined {
	return asNumber(value);
}

function parseUser(value: unknown): TokenGoUser {
	if (!isRecord(value)) throw new Error("TokenGo user response is invalid");
	const displayName = asString(value.display_name);
	const group = asString(value.group);
	const quota = optionalNumber(value.quota);
	const usedQuota = optionalNumber(value.used_quota);
	return {
		id: requiredNumber(value.id, "id"),
		username: requiredString(value.username, "username"),
		...(displayName !== undefined ? { display_name: displayName } : {}),
		...(group !== undefined ? { group } : {}),
		...(quota !== undefined ? { quota } : {}),
		...(usedQuota !== undefined ? { used_quota: usedQuota } : {}),
	};
}

function parseGroups(value: unknown): Record<string, TokenGoGroup> {
	if (!isRecord(value)) throw new Error("TokenGo groups response is invalid");
	const result: Record<string, TokenGoGroup> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!isRecord(raw) || (typeof raw.ratio !== "number" && typeof raw.ratio !== "string")) {
			throw new Error(`TokenGo group ${key} is invalid`);
		}
		const desc = asString(raw.desc);
		result[key] = {
			ratio: raw.ratio,
			...(desc !== undefined ? { desc } : {}),
		};
	}
	return result;
}

function parsePricing(value: unknown): TokenGoPricing {
	if (!isRecord(value)) throw new Error("TokenGo pricing response is invalid");
	const modelName = requiredString(value.model_name, "model_name");
	const quotaType = requiredNumber(value.quota_type, "quota_type");
	const modelRatio = optionalNumber(value.model_ratio);
	const modelPrice = optionalNumber(value.model_price);
	const completionRatio = optionalNumber(value.completion_ratio);
	const cacheRatio = optionalNumber(value.cache_ratio);
	const createCacheRatio = optionalNumber(value.create_cache_ratio);
	const arrayStrings = (entry: unknown): string[] | undefined =>
		Array.isArray(entry) && entry.every(item => typeof item === "string") ? [...entry] : undefined;
	const enableGroups = arrayStrings(value.enable_groups);
	const endpointTypes = arrayStrings(value.supported_endpoint_types);
	const ownerBy = asString(value.owner_by);
	const description = asString(value.description);
	const tags = asString(value.tags);
	return {
		model_name: modelName,
		quota_type: quotaType,
		...(modelRatio !== undefined ? { model_ratio: modelRatio } : {}),
		...(modelPrice !== undefined ? { model_price: modelPrice } : {}),
		...(completionRatio !== undefined ? { completion_ratio: completionRatio } : {}),
		...(cacheRatio !== undefined ? { cache_ratio: cacheRatio } : {}),
		...(createCacheRatio !== undefined ? { create_cache_ratio: createCacheRatio } : {}),
		...(enableGroups ? { enable_groups: enableGroups } : {}),
		...(endpointTypes ? { supported_endpoint_types: endpointTypes } : {}),
		...(ownerBy !== undefined ? { owner_by: ownerBy } : {}),
		...(description !== undefined ? { description } : {}),
		...(tags !== undefined ? { tags } : {}),
	};
}

function parseToken(value: unknown): TokenGoToken {
	if (!isRecord(value)) throw new Error("TokenGo token response is invalid");
	const key = asString(value.key);
	const group = asString(value.group);
	const unlimitedQuota = typeof value.unlimited_quota === "boolean" ? value.unlimited_quota : undefined;
	const remainQuota = optionalNumber(value.remain_quota);
	const expiredTime = optionalNumber(value.expired_time);
	return {
		id: requiredNumber(value.id, "id"),
		name: requiredString(value.name, "name"),
		...(key !== undefined ? { key } : {}),
		...(group !== undefined ? { group } : {}),
		status: requiredNumber(value.status, "status"),
		...(unlimitedQuota !== undefined ? { unlimited_quota: unlimitedQuota } : {}),
		...(remainQuota !== undefined ? { remain_quota: remainQuota } : {}),
		...(expiredTime !== undefined ? { expired_time: expiredTime } : {}),
	};
}

function parseEnvelope(value: unknown): TokenGoEnvelope {
	if (!isRecord(value) || typeof value.success !== "boolean") {
		throw new Error("TokenGo response envelope is invalid");
	}
	const message = asString(value.message);
	return {
		success: value.success,
		...(message !== undefined ? { message } : {}),
		...("data" in value ? { data: value.data } : {}),
	};
}

function redactToken(message: string, token: string): string {
	return token.length > 0 ? message.replaceAll(token, "[redacted]") : message;
}

function tokenGoModelBaseUrl(api: TokenGoModelEndpoint["api"], baseUrl: string): string {
	return api === "anthropic-messages" ? tokenGoRootUrl(baseUrl) : tokenGoInferenceUrl(baseUrl);
}

/** Strip only the conventional `/v1` suffix; account APIs live at the root. */
export function tokenGoRootUrl(baseUrl = TOKEN_GO_BASE_URL): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function tokenGoInferenceUrl(baseUrl = TOKEN_GO_BASE_URL): string {
	return `${tokenGoRootUrl(baseUrl)}/v1`;
}

export function createTokenGoClient(input: TokenGoClientOptions): TokenGoClient {
	const base = tokenGoRootUrl(input.baseUrl);
	const run = input.fetch ?? globalThis.fetch;
	const suppliedAuthToken = input.authToken ?? input.pat;
	if (typeof suppliedAuthToken !== "string" || !suppliedAuthToken.trim()) {
		throw new Error("TokenGo authentication token is required");
	}
	const authToken: string = suppliedAuthToken;

	async function send(method: string, path: string, body?: unknown): Promise<{ data: unknown; raw: unknown }> {
		const response = await run(`${base}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${authToken}`,
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
		});
		const raw = await response.json().catch(() => undefined);
		let envelope: TokenGoEnvelope;
		try {
			envelope = parseEnvelope(raw);
		} catch {
			throw new Error(`TokenGo ${path}: unexpected response (HTTP ${response.status})`);
		}
		if (!response.ok || !envelope.success) {
			const message = envelope.message
				? redactToken(envelope.message, authToken)
				: `TokenGo ${path}: request failed (HTTP ${response.status})`;
			throw new Error(message);
		}
		return { data: envelope.data, raw };
	}

	async function call(method: string, path: string, body?: unknown): Promise<unknown> {
		return (await send(method, path, body)).data;
	}

	async function pricingEnvelope(): Promise<TokenGoPricingEnvelope> {
		const { data, raw } = await send("GET", "/api/pricing");
		if (!Array.isArray(data)) throw new Error("TokenGo pricing response is invalid");
		const ratios = isRecord(raw) && isRecord(raw.group_ratio) ? raw.group_ratio : {};
		const groupRatio: Record<string, number> = {};
		for (const [key, value] of Object.entries(ratios)) {
			if (asNumber(value) !== undefined) groupRatio[key] = value as number;
		}
		return { data: data.map(parsePricing), group_ratio: groupRatio };
	}

	return {
		async self() {
			return parseUser(await call("GET", "/api/user/self"));
		},
		async groups() {
			return parseGroups(await call("GET", "/api/user/self/groups"));
		},
		async userModels(group) {
			const data = await call("GET", `/api/user/models?group=${encodeURIComponent(group)}`);
			if (!Array.isArray(data) || !data.every(item => typeof item === "string")) {
				throw new Error("TokenGo user models response is invalid");
			}
			return [...data];
		},
		async openAiModels() {
			const response = await run(`${base}/v1/models`, {
				method: "GET",
				headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" },
				signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
			});
			const payload: unknown = await response.json().catch(() => undefined);
			if (!response.ok || !isRecord(payload) || !Array.isArray(payload.data) || !payload.data.every(isRecord)) {
				throw new Error("TokenGo /v1/models response is invalid");
			}
			return [...payload.data];
		},
		async pricing() {
			return (await pricingEnvelope()).data;
		},
		pricingEnvelope,
		async tokens() {
			const all: TokenGoToken[] = [];
			const seen = new Set<number>();
			for (let page = 1; page <= MAX_TOKEN_PAGES; page++) {
				const data = await call("GET", `/api/token/?p=${page}&size=${TOKEN_PAGE_SIZE}`);
				if (!isRecord(data) || !Array.isArray(data.items)) throw new Error("TokenGo token page is invalid");
				const items = data.items.map(parseToken);
				const fresh = items.filter(item => !seen.has(item.id));
				for (const item of fresh) seen.add(item.id);
				all.push(...fresh);
				const total = optionalNumber(data.total);
				if (fresh.length === 0 || items.length < TOKEN_PAGE_SIZE || (total !== undefined && all.length >= total))
					break;
			}
			return all;
		},
		async createToken(body) {
			await call("POST", "/api/token/", body);
		},
		async tokenKey(id) {
			const data = await call("POST", `/api/token/${id}/key`);
			if (!isRecord(data)) throw new Error("TokenGo token key response is invalid");
			return requiredString(data.key, "key");
		},
	};
}

export function requireTokenGoGroup(groups: Record<string, TokenGoGroup>, group = TOKEN_GO_CLI_GROUP): string {
	if (group in groups) return group;
	throw new Error(
		`Your TokenGo account has no active subscription for the CLI ("${group}" group). Check your subscription at ${TOKEN_GO_SUBSCRIBE_URL}.`,
	);
}

export interface TokenGoProvisionedCredential {
	apiKey: string;
	/** Non-secret fields safe to persist in an environment/config snapshot. */
	metadata: {
		baseUrl: string;
		group: string;
		username: string;
		userId: string;
	};
}

export interface TokenGoProvisionInput {
	client: TokenGoClient;
	baseUrl: string;
	group: string;
	user?: TokenGoUser;
}

/** Find or create the durable NewAPI key used for inference. */
export async function provisionTokenGoCredential(input: TokenGoProvisionInput): Promise<TokenGoProvisionedCredential> {
	const name = TOKEN_GO_TOKEN_NAME;
	const user = input.user ?? (await input.client.self());
	const find = async () =>
		(await input.client.tokens()).find(
			token => token.name === name && token.group === input.group && token.status === TOKEN_ENABLED,
		);
	const existing = await find();
	if (!existing) {
		await input.client.createToken({
			name,
			group: input.group,
			unlimited_quota: true,
			remain_quota: 0,
			expired_time: -1,
			model_limits_enabled: false,
			model_limits: "",
			allow_ips: "",
		});
	}
	const token = existing ?? (await find());
	if (!token) throw new Error(`TokenGo token ${name} was created but not found`);
	return {
		apiKey: await input.client.tokenKey(token.id),
		metadata: {
			baseUrl: tokenGoRootUrl(input.baseUrl),
			group: input.group,
			username: user.username,
			userId: String(user.id),
		},
	};
}

export interface TokenGoDiscoveredModel {
	id: string;
	api: TokenGoModelEndpoint["api"];
	baseUrl: string;
	pricing?: TokenGoPricing;
}

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

/** Discover models with the provisioned NewAPI key, without PAT-only APIs. */
export async function discoverTokenGoInferenceModels(
	client: TokenGoClient,
	baseUrl = TOKEN_GO_BASE_URL,
): Promise<TokenGoDiscoveredModel[]> {
	const rows = await client.openAiModels();
	return rows.flatMap(row => {
		const id = asString(row.id);
		if (!id) return [];
		const advertised = Array.isArray(row.supported_endpoint_types)
			? row.supported_endpoint_types.filter((value): value is string => typeof value === "string")
			: [];
		if (
			advertised.length > 0 &&
			!advertised.some(
				endpoint => isCompletionsEndpoint(endpoint) || isResponsesEndpoint(endpoint) || endpoint === "anthropic",
			)
		) {
			return [];
		}
		const api = endpointForModel(id, undefined, row);
		return [{ id, api, baseUrl: tokenGoModelBaseUrl(api, baseUrl) }];
	});
}

function endpointForModel(
	id: string,
	pricing: TokenGoPricing | undefined,
	raw?: Readonly<Record<string, unknown>>,
): TokenGoModelEndpoint["api"] {
	const advertised = raw?.supported_endpoint_types;
	const endpoints = [
		...(pricing?.supported_endpoint_types ?? []),
		...(Array.isArray(advertised) ? advertised.filter((value): value is string => typeof value === "string") : []),
	];
	const bare = id.toLowerCase().replace(/^.*\//, "");
	const isClaude = /^claude(?:-|$)/.test(bare);
	if (isClaude && endpoints.includes("anthropic")) return "anthropic-messages";
	if (!isClaude && endpoints.some(isResponsesEndpoint)) {
		return "openai-responses";
	}
	if (endpoints.some(isCompletionsEndpoint)) return "openai-completions";
	if (endpoints.includes("anthropic")) return "anthropic-messages";
	if (/^claude(?:-|$)/.test(bare)) return "anthropic-messages";
	if (/^(?:gpt|o[1-9]|codex|chatgpt)(?:-|$)/.test(bare)) return "openai-responses";
	return "openai-completions";
}

/** Combine account model entitlements with optional pricing metadata. */
export async function discoverTokenGoModels(
	client: TokenGoClient,
	group: string,
	baseUrl = TOKEN_GO_BASE_URL,
): Promise<TokenGoDiscoveredModel[]> {
	const names = await client.userModels(group);
	let rows = new Map<string, TokenGoPricing>();
	try {
		const pricing = await client.pricingEnvelope();
		rows = new Map(pricing.data.map(row => [row.model_name, row]));
	} catch {
		// The relay may authorize model entitlements while hiding pricing.
		// Keep the models usable with zero-cost metadata in that case.
	}
	return names.flatMap(id => {
		const pricing = rows.get(id);
		const advertised = pricing?.supported_endpoint_types ?? [];
		if (
			advertised.length > 0 &&
			!advertised.some(
				endpoint => endpoint === "openai" || endpoint === "openai-response" || endpoint === "anthropic",
			)
		) {
			return [];
		}
		const api = endpointForModel(id, pricing);
		return [
			{
				id,
				api,
				baseUrl: tokenGoModelBaseUrl(api, baseUrl),
				...(pricing !== undefined ? { pricing } : {}),
			},
		];
	});
}

export function tokenGoQuotaToUsd(quota: number): number {
	return quota / QUOTA_PER_USD;
}
