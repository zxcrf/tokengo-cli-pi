/**
 * TokenGo provider: NewAPI relay with a dynamic, persisted model catalog and
 * per-model protocol routing (Anthropic Messages / OpenAI Completions /
 * OpenAI Responses).
 *
 * Slice 0 stub: signatures are frozen, bodies are filled in by slice S1.
 */

import type { ApiKeyAuth } from "../auth/types.ts";
import type { Provider, RefreshModelsContext } from "../models.ts";
import type { Model, ModelCost, ProviderEnv } from "../types.ts";
import type { TokenGoPricing } from "./token-go-client.ts";

export const TOKEN_GO_PROVIDER_ID = "token-go";
export const TOKEN_GO_PROVIDER_NAME = "TokenGo";
/** Assumed until the live relay probe (step 0). */
export const TOKEN_GO_DEFAULT_MODEL_ID = "claude-sonnet-4-5";
/** Substring match, in order, when ordering the catalog and choosing a default. */
export const TOKEN_GO_MODEL_PRIORITY: readonly string[] = [
	"claude-sonnet-4-5",
	"claude-opus-4-5",
	"gpt-5-codex",
	"gpt-5",
	"claude-sonnet-4",
	"gemini-2.5-pro",
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

export function readTokenGoCredentialEnv(_env: ProviderEnv | undefined): TokenGoCredentialEnv {
	throw new Error("not implemented");
}

export function selectTokenGoApi(_modelId: string, _endpointTypes: readonly string[]): TokenGoApi | undefined {
	throw new Error("not implemented");
}

export function tokenGoBaseUrlForApi(_baseUrl: string, _api: TokenGoApi): string {
	throw new Error("not implemented");
}

export function tokenGoModelCost(_row: TokenGoPricing | undefined, _groupRatio: number): ModelCost {
	throw new Error("not implemented");
}

export function sortByTokenGoPriority<T extends { id: string }>(_models: readonly T[]): T[] {
	throw new Error("not implemented");
}

export function buildTokenGoModels(_input: {
	names: readonly string[];
	pricing: readonly TokenGoPricing[];
	groupRatio: number;
	baseUrl: string;
}): Model<TokenGoApi>[] {
	throw new Error("not implemented");
}

export function tokenGoApiKeyAuth(_options?: TokenGoProviderOptions): ApiKeyAuth {
	throw new Error("not implemented");
}

export function fetchTokenGoModels(
	_context: RefreshModelsContext,
	_options?: TokenGoProviderOptions,
): Promise<Model<TokenGoApi>[]> {
	throw new Error("not implemented");
}

export function tokenGoProvider(_options?: TokenGoProviderOptions): Provider<TokenGoApi> {
	throw new Error("not implemented");
}
