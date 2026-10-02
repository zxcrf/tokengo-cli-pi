/**
 * TokenGo (NewAPI relay) dashboard client. Plain fetch, no Node-only imports:
 * this module is reachable from the browser bundle through providers/all.ts.
 *
 * Slice 0 stub: signatures are frozen, bodies are filled in by slice S1.
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

export function createTokenGoClient(_options: TokenGoClientOptions): TokenGoClient {
	throw new Error("not implemented");
}

/** Trim, strip trailing "/", default TOKEN_GO_BASE_URL. */
export function normalizeTokenGoBaseUrl(_url: string | undefined): string {
	throw new Error("not implemented");
}

export function requireTokenGoGroup(_groups: Record<string, TokenGoGroup>): string {
	throw new Error("not implemented");
}

export interface TokenGoProvisioned {
	key: string;
	user: TokenGoUser;
	group: string;
}

export function provisionTokenGoKey(_input: {
	client: TokenGoClient;
	group: string;
	user?: TokenGoUser;
}): Promise<TokenGoProvisioned> {
	throw new Error("not implemented");
}

export function quotaToUSD(_quota: number): number {
	throw new Error("not implemented");
}
