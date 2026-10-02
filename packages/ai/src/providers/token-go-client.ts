/**
 * TokenGo (NewAPI relay) dashboard client. Plain fetch, no Node-only imports:
 * this module is reachable from the browser bundle through providers/all.ts.
 */

export const TOKEN_GO_BASE_URL = "https://api.token-go.click";
export const TOKEN_GO_CLI_GROUP = "tokengo";
export const TOKEN_GO_TOKEN_NAME = "tokengo-cli";
export const TOKEN_GO_SUBSCRIBE_URL = "https://token-go.click/wallet";
export const TOKEN_GO_CONSOLE_URL = "https://token-go.click/console/personal";
export const TOKEN_GO_QUOTA_PER_USD = 500_000;
export const TOKEN_GO_DEFAULT_TIMEOUT_MS = 10_000;
export const TOKEN_GO_AUTH_HINT =
	"Your TokenGo system access token (系统访问令牌) was rejected. Generate a new one in the TokenGo console (个人设置) and run `tokengo login` again.";

export interface TokenGoUser {
	id: number;
	username: string;
	display_name?: string;
	group?: string;
	quota?: number;
	used_quota?: number;
}

export interface TokenGoGroup {
	/** The `auto` group reports a localized string instead of a number. */
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

/** `/api/pricing` carries the per-group price multipliers next to `data`. */
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

export interface TokenGoCreateTokenBody {
	name: string;
	group: string;
	unlimited_quota: boolean;
	remain_quota: number;
	expired_time: number;
	model_limits_enabled: boolean;
	model_limits: string;
	allow_ips: string;
}

export class TokenGoError extends Error {
	/** HTTP status; undefined for network, timeout and parse failures. */
	readonly status: number | undefined;
	/** Request path, e.g. "/api/user/self". */
	readonly path: string;
	/** TOKEN_GO_AUTH_HINT on 401/403. */
	readonly hint: string | undefined;

	constructor(message: string, options: { status?: number; path: string; hint?: string; cause?: unknown }) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "TokenGoError";
		this.status = options.status;
		this.path = options.path;
		this.hint = options.hint;
	}
}

export interface TokenGoClientOptions {
	pat: string;
	/** Default TOKEN_GO_BASE_URL, normalized. */
	baseUrl?: string;
	/** When set, sent as the `New-Api-User` header. */
	userId?: string;
	fetch?: typeof globalThis.fetch;
	/** Per request, default TOKEN_GO_DEFAULT_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Combined with the timeout via AbortSignal.any. */
	signal?: AbortSignal;
}

export interface TokenGoClient {
	readonly baseUrl: string;
	/** GET /api/user/self */
	self(): Promise<TokenGoUser>;
	/** GET /api/user/self/groups */
	groups(): Promise<Record<string, TokenGoGroup>>;
	/** GET /api/user/models?group=<enc> */
	userModels(group: string): Promise<string[]>;
	/** GET /api/pricing (throws on 401/403) */
	pricingEnvelope(): Promise<TokenGoPricingEnvelope>;
	/** GET /api/token/?p=<n>&size=100, all pages */
	tokens(): Promise<TokenGoToken[]>;
	/** POST /api/token/ */
	createToken(body: TokenGoCreateTokenBody): Promise<void>;
	/** POST /api/token/<id>/key -> data.key */
	tokenKey(id: number): Promise<string>;
}

const MAX_TOKEN_PAGES = 50;
const TOKEN_PAGE_SIZE = 100;
const TOKEN_ENABLED = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
	return value === undefined || typeof value === "number";
}

function isUser(value: unknown): value is TokenGoUser {
	return (
		isRecord(value) &&
		typeof value.id === "number" &&
		typeof value.username === "string" &&
		optionalString(value.display_name) &&
		optionalString(value.group) &&
		optionalNumber(value.quota) &&
		optionalNumber(value.used_quota)
	);
}

function isGroup(value: unknown): value is TokenGoGroup {
	return (
		isRecord(value) &&
		(typeof value.ratio === "number" || typeof value.ratio === "string") &&
		optionalString(value.desc)
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPricing(value: unknown): value is TokenGoPricing {
	return (
		isRecord(value) &&
		typeof value.model_name === "string" &&
		typeof value.quota_type === "number" &&
		optionalNumber(value.model_ratio) &&
		optionalNumber(value.model_price) &&
		optionalNumber(value.completion_ratio) &&
		optionalNumber(value.cache_ratio) &&
		optionalNumber(value.create_cache_ratio) &&
		(value.enable_groups === undefined || isStringArray(value.enable_groups)) &&
		(value.supported_endpoint_types === undefined || isStringArray(value.supported_endpoint_types))
	);
}

function isToken(value: unknown): value is TokenGoToken {
	return (
		isRecord(value) &&
		typeof value.id === "number" &&
		typeof value.name === "string" &&
		typeof value.status === "number" &&
		optionalString(value.key) &&
		optionalString(value.group)
	);
}

function unexpected(path: string, what: string): TokenGoError {
	return new TokenGoError(`TokenGo ${path}: unexpected ${what}`, { path });
}

/** Trim, strip trailing "/", default TOKEN_GO_BASE_URL. */
export function normalizeTokenGoBaseUrl(url: string | undefined): string {
	const trimmed = url?.trim().replace(/\/+$/, "");
	return trimmed ? trimmed : TOKEN_GO_BASE_URL;
}

export function createTokenGoClient(options: TokenGoClientOptions): TokenGoClient {
	const baseUrl = normalizeTokenGoBaseUrl(options.baseUrl);
	const run = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? TOKEN_GO_DEFAULT_TIMEOUT_MS;

	// Never include the PAT in thrown messages or causes. Returns the raw JSON body after the envelope check.
	async function send(method: string, path: string, body?: unknown): Promise<{ data: unknown; raw: unknown }> {
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		let res: Response;
		let json: unknown;
		try {
			res = await run(`${baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${options.pat}`,
					Accept: "application/json",
					...(options.userId ? { "New-Api-User": options.userId } : {}),
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			});
			json = await res.json().catch((bodyError: unknown) => {
				// Abort or timeout while reading the body is not a malformed response.
				if (signal.aborted) throw bodyError;
				return undefined;
			});
		} catch (error) {
			if (options.signal?.aborted) throw options.signal.reason;
			const reason = timeout.aborted ? "request timed out" : "request failed";
			// Re-wrap: the original error text is not guaranteed to be free of request details.
			throw new TokenGoError(`TokenGo ${path}: ${reason}`, {
				path,
				cause: new Error(error instanceof Error ? error.name : "network error"),
			});
		}
		if (!isRecord(json) || typeof json.success !== "boolean") {
			throw new TokenGoError(`TokenGo ${path}: unexpected response (HTTP ${res.status})`, {
				path,
				status: res.status,
				hint: res.status === 401 || res.status === 403 ? TOKEN_GO_AUTH_HINT : undefined,
			});
		}
		if (!res.ok || !json.success) {
			const message = typeof json.message === "string" ? json.message : "";
			throw new TokenGoError(message || `TokenGo ${path}: request failed (HTTP ${res.status})`, {
				path,
				status: res.status,
				hint: res.status === 401 || res.status === 403 ? TOKEN_GO_AUTH_HINT : undefined,
			});
		}
		return { data: json.data, raw: json };
	}

	async function call(method: string, path: string, body?: unknown): Promise<unknown> {
		return (await send(method, path, body)).data;
	}

	return {
		baseUrl,
		async self() {
			const path = "/api/user/self";
			const data = await call("GET", path);
			if (!isUser(data)) throw unexpected(path, "user shape");
			return data;
		},
		async groups() {
			const path = "/api/user/self/groups";
			const data = await call("GET", path);
			if (!isRecord(data) || !Object.values(data).every(isGroup)) throw unexpected(path, "groups shape");
			return data as Record<string, TokenGoGroup>;
		},
		async userModels(group) {
			const path = `/api/user/models?group=${encodeURIComponent(group)}`;
			const data = await call("GET", path);
			if (!isStringArray(data)) throw unexpected(path, "models shape");
			return data;
		},
		async pricingEnvelope() {
			const path = "/api/pricing";
			const { data, raw } = await send("GET", path);
			if (!Array.isArray(data) || !data.every(isPricing)) throw unexpected(path, "pricing shape");
			const ratios = isRecord(raw) && isRecord(raw.group_ratio) ? raw.group_ratio : {};
			const groupRatio: Record<string, number> = {};
			for (const [name, ratio] of Object.entries(ratios)) {
				if (isFiniteNumber(ratio)) groupRatio[name] = ratio;
			}
			return { data, group_ratio: groupRatio };
		},
		async tokens() {
			const all: TokenGoToken[] = [];
			const seen = new Set<number>();
			// Bounded: a server that ignores `p` and omits `total` would otherwise loop forever.
			for (let page = 1; page <= MAX_TOKEN_PAGES; page++) {
				const path = `/api/token/?p=${page}&size=${TOKEN_PAGE_SIZE}`;
				const data = await call("GET", path);
				if (!isRecord(data) || !Array.isArray(data.items) || !data.items.every(isToken)) {
					throw unexpected(path, "token page shape");
				}
				const items: TokenGoToken[] = data.items;
				const fresh = items.filter((token) => !seen.has(token.id));
				for (const token of fresh) seen.add(token.id);
				all.push(...fresh);
				const total = typeof data.total === "number" ? data.total : Number.POSITIVE_INFINITY;
				if (fresh.length === 0 || items.length < TOKEN_PAGE_SIZE || all.length >= total) break;
			}
			return all;
		},
		async createToken(body) {
			await call("POST", "/api/token/", body);
		},
		async tokenKey(id) {
			const path = `/api/token/${id}/key`;
			const data = await call("POST", path);
			if (!isRecord(data) || typeof data.key !== "string") throw unexpected(path, "token key shape");
			return data.key;
		},
	};
}

export function requireTokenGoGroup(groups: Record<string, TokenGoGroup>): string {
	if (TOKEN_GO_CLI_GROUP in groups) return TOKEN_GO_CLI_GROUP;
	throw new TokenGoError(
		`Your TokenGo account has no active subscription for the CLI ("${TOKEN_GO_CLI_GROUP}" group). Check your subscription at ${TOKEN_GO_SUBSCRIBE_URL}, then run \`tokengo login\` again.`,
		{ path: "/api/user/self/groups" },
	);
}

export interface TokenGoProvisioned {
	key: string;
	user: TokenGoUser;
	group: string;
}

export async function provisionTokenGoKey(input: {
	client: TokenGoClient;
	group: string;
	user?: TokenGoUser;
}): Promise<TokenGoProvisioned> {
	const { client, group } = input;
	const user = input.user ?? (await client.self());
	const find = async () =>
		(await client.tokens()).find(
			(token) => token.name === TOKEN_GO_TOKEN_NAME && token.group === group && token.status === TOKEN_ENABLED,
		);
	const existing = await find();
	if (!existing) {
		await client.createToken({
			name: TOKEN_GO_TOKEN_NAME,
			group,
			unlimited_quota: true,
			remain_quota: 0,
			expired_time: -1,
			model_limits_enabled: false,
			model_limits: "",
			allow_ips: "",
		});
	}
	const token = existing ?? (await find());
	if (!token) {
		throw new TokenGoError(`TokenGo token ${TOKEN_GO_TOKEN_NAME} was created but not found`, {
			path: "/api/token/",
		});
	}
	return { key: await client.tokenKey(token.id), user, group };
}

export function quotaToUSD(quota: number): number {
	return quota / TOKEN_GO_QUOTA_PER_USD;
}
