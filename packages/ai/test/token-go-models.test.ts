import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.ts";
import {
	buildTokenGoModels,
	selectTokenGoApi,
	sortByTokenGoPriority,
	TOKEN_GO_MODEL_PRIORITY,
	tokenGoBaseUrlForApi,
	tokenGoModelCost,
} from "../src/providers/token-go.ts";
import type { TokenGoPricing } from "../src/providers/token-go-client.ts";

const BASE = "https://relay.test";

function row(
	model_name: string,
	supported_endpoint_types: string[],
	extra: Partial<TokenGoPricing> = {},
): TokenGoPricing {
	return { model_name, quota_type: 0, model_ratio: 1, supported_endpoint_types, ...extra };
}

describe("selectTokenGoApi", () => {
	it("routes claude models to anthropic-messages only when the relay offers it", () => {
		expect(selectTokenGoApi("claude-sonnet-4-5", ["anthropic", "openai"])).toBe("anthropic-messages");
		expect(selectTokenGoApi("claude-sonnet-4-5", ["openai"])).toBe("openai-completions");
		expect(selectTokenGoApi("vendor/Claude-Opus-4-5", ["anthropic"])).toBe("anthropic-messages");
	});

	it("routes gpt/o-series/codex/chatgpt to responses when offered", () => {
		for (const id of ["gpt-5", "o1-mini", "o3", "codex-mini", "chatgpt-4o-latest", "openai/gpt-5-codex"]) {
			expect(selectTokenGoApi(id, ["openai", "openai-response"])).toBe("openai-responses");
			expect(selectTokenGoApi(id, ["openai"])).toBe("openai-completions");
		}
	});

	it("uses completions for everything else and drops models without an openai route", () => {
		expect(selectTokenGoApi("deepseek-chat", ["openai", "openai-response"])).toBe("openai-completions");
		expect(selectTokenGoApi("deepseek-chat", ["anthropic"])).toBeUndefined();
		expect(selectTokenGoApi("claude-x", [])).toBeUndefined();
		expect(selectTokenGoApi("gpt-5", ["openai-response"])).toBe("openai-responses");
		expect(selectTokenGoApi("gpt-5", ["anthropic"])).toBeUndefined();
	});
});

describe("tokenGoBaseUrlForApi", () => {
	it("uses the root for anthropic and /v1 for openai apis", () => {
		expect(tokenGoBaseUrlForApi(BASE, "anthropic-messages")).toBe(BASE);
		expect(tokenGoBaseUrlForApi(BASE, "openai-completions")).toBe(`${BASE}/v1`);
		expect(tokenGoBaseUrlForApi(BASE, "openai-responses")).toBe(`${BASE}/v1`);
	});
});

describe("tokenGoModelCost", () => {
	it("prices per-token rows including the group ratio", () => {
		const cost = tokenGoModelCost(
			{
				model_name: "m",
				quota_type: 0,
				model_ratio: 1.5,
				completion_ratio: 5,
				cache_ratio: 0.1,
				create_cache_ratio: 1.25,
			},
			0.8,
		);
		expect(cost.input).toBeCloseTo(2.4);
		expect(cost.output).toBeCloseTo(12);
		expect(cost.cacheRead).toBeCloseTo(0.24);
		expect(cost.cacheWrite).toBeCloseTo(3);
	});

	it("defaults completion and cache ratios to 1, 1 and 1.25", () => {
		const cost = tokenGoModelCost({ model_name: "m", quota_type: 0, model_ratio: 1 }, 1);
		expect(cost).toEqual({ input: 2, output: 2, cacheRead: 2, cacheWrite: 2.5 });
	});

	it("reports zero for per-call pricing and missing rows", () => {
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		expect(tokenGoModelCost({ model_name: "m", quota_type: 1, model_price: 0.1 }, 1)).toEqual(zero);
		expect(tokenGoModelCost(undefined, 1)).toEqual(zero);
	});
});

describe("buildTokenGoModels", () => {
	it("drops non-chat names and models without an openai route", () => {
		const models = buildTokenGoModels({
			names: [
				"text-embedding-3-small",
				"bge-rerank-v2",
				"whisper-1",
				"tts-1",
				"dall-e-3",
				"only-anthropic",
				"deepseek-chat",
			],
			pricing: [row("only-anthropic", ["anthropic"]), row("deepseek-chat", ["openai"])],
			groupRatio: 1,
			baseUrl: BASE,
		});
		expect(models.map((model) => model.id)).toEqual(["deepseek-chat"]);
	});

	it("sets provider, api, base url and cost per model", () => {
		const models = buildTokenGoModels({
			names: ["claude-sonnet-4-5", "gpt-5", "deepseek-chat"],
			pricing: [
				row("claude-sonnet-4-5", ["anthropic", "openai"], { model_ratio: 1.5, completion_ratio: 5 }),
				row("gpt-5", ["openai", "openai-response"]),
				row("deepseek-chat", ["openai"]),
			],
			groupRatio: 0.8,
			baseUrl: BASE,
		});
		const byId = new Map(models.map((model) => [model.id, model]));
		expect(byId.get("claude-sonnet-4-5")).toMatchObject({
			provider: "token-go",
			api: "anthropic-messages",
			baseUrl: BASE,
		});
		expect(byId.get("claude-sonnet-4-5")?.cost.input).toBeCloseTo(2.4);
		expect(byId.get("gpt-5")).toMatchObject({ api: "openai-responses", baseUrl: `${BASE}/v1` });
		expect(byId.get("deepseek-chat")).toMatchObject({ api: "openai-completions", baseUrl: `${BASE}/v1` });
	});

	it("defaults missing pricing rows to openai-only endpoints", () => {
		const [model] = buildTokenGoModels({ names: ["claude-sonnet-4-5"], pricing: [], groupRatio: 1, baseUrl: BASE });
		expect(model.api).toBe("openai-completions");
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("copies metadata from the generated reference catalog by exact id", () => {
		const reference = MODELS.anthropic["claude-sonnet-4-5"];
		const [model] = buildTokenGoModels({
			names: ["claude-sonnet-4-5"],
			pricing: [row("claude-sonnet-4-5", ["anthropic"])],
			groupRatio: 1,
			baseUrl: BASE,
		});
		expect(model.contextWindow).toBe(reference.contextWindow);
		expect(model.maxTokens).toBe(reference.maxTokens);
		expect(model.reasoning).toBe(reference.reasoning);
		expect(model.input).toEqual(reference.input);
		expect(model.name).toBe(reference.name.replace(/\s*\(latest\)\s*$/i, ""));
		expect(model.id).toBe("claude-sonnet-4-5");
	});

	it("copies compat only when the reference api matches and strips allowedFallbackModels", () => {
		const [anthropic] = buildTokenGoModels({
			names: ["claude-sonnet-4-5"],
			pricing: [row("claude-sonnet-4-5", ["anthropic"])],
			groupRatio: 1,
			baseUrl: BASE,
		});
		expect(anthropic.compat).not.toHaveProperty("allowedFallbackModels");
		const [openaiRouted] = buildTokenGoModels({
			names: ["claude-sonnet-4-5"],
			pricing: [row("claude-sonnet-4-5", ["openai"])],
			groupRatio: 1,
			baseUrl: BASE,
		});
		expect(openaiRouted.api).toBe("openai-completions");
		expect(openaiRouted.compat).toBeUndefined();
	});

	it("copies thinkingLevelMap and compat from canonical refs only when the api matches", () => {
		const reference = MODELS.anthropic["claude-fable-5"];
		expect(reference.thinkingLevelMap).toBeDefined();
		const [native] = buildTokenGoModels({
			names: ["claude-fable-5"],
			pricing: [row("claude-fable-5", ["anthropic"])],
			groupRatio: 1,
			baseUrl: BASE,
		});
		expect(native.thinkingLevelMap).toEqual(reference.thinkingLevelMap);
		expect(native.compat).toMatchObject({ supportsMidConvoSystemMessages: true });
		const [routed] = buildTokenGoModels({
			names: ["claude-fable-5"],
			pricing: [row("claude-fable-5", ["openai"])],
			groupRatio: 1,
			baseUrl: BASE,
		});
		expect(routed.api).toBe("openai-completions");
		expect(routed.thinkingLevelMap).toBeUndefined();
		expect(routed.compat).toBeUndefined();
		expect(routed.contextWindow).toBe(reference.contextWindow);
	});

	it("fills aggregator-only ids with limits but no compat, thinking map, cache or pretty name", () => {
		const reference = MODELS.openrouter["moonshotai/kimi-k2-thinking"];
		expect(reference.compat).toBeDefined();
		const [model] = buildTokenGoModels({
			names: ["moonshotai/kimi-k2-thinking"],
			pricing: [row("moonshotai/kimi-k2-thinking", ["openai"])],
			groupRatio: 1,
			baseUrl: BASE,
		});
		expect(model.name).toBe("moonshotai/kimi-k2-thinking");
		expect(model.contextWindow).toBe(reference.contextWindow);
		expect(model.maxTokens).toBe(reference.maxTokens);
		expect(model.reasoning).toBe(reference.reasoning);
		expect(model.compat).toBeUndefined();
		expect(model.thinkingLevelMap).toBeUndefined();
		expect(model.promptCache).toBeUndefined();
	});

	it("matches dated and vendor-prefixed ids through the normalized fallback", () => {
		const reference = MODELS.anthropic["claude-sonnet-4-5"];
		const models = buildTokenGoModels({
			names: ["claude-sonnet-4-5-20250929", "anthropic/Claude-Sonnet-4.5"],
			pricing: [],
			groupRatio: 1,
			baseUrl: BASE,
		});
		for (const model of models) {
			expect(model.contextWindow).toBe(reference.contextWindow);
			expect(model.reasoning).toBe(reference.reasoning);
		}
		expect(models.map((model) => model.id).sort()).toEqual([
			"anthropic/Claude-Sonnet-4.5",
			"claude-sonnet-4-5-20250929",
		]);
	});

	it("strips repeated date and preview suffixes when normalizing", () => {
		const reference = MODELS.anthropic["claude-sonnet-4-5"];
		const [model] = buildTokenGoModels({
			names: ["claude-sonnet-4-5-20250929-preview"],
			pricing: [],
			groupRatio: 1,
			baseUrl: BASE,
		});
		expect(model.contextWindow).toBe(reference.contextWindow);
	});

	it("falls back conservatively for unknown ids", () => {
		const [plain, thinker] = buildTokenGoModels({
			names: ["zz-unknown-chat", "zz-unknown-reasoner"],
			pricing: [],
			groupRatio: 1,
			baseUrl: BASE,
		}).sort((a, b) => a.id.localeCompare(b.id));
		expect(plain).toMatchObject({
			id: "zz-unknown-chat",
			name: "zz-unknown-chat",
			reasoning: false,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 32000,
		});
		expect(thinker.reasoning).toBe(true);
	});

	it("orders the result by priority", () => {
		const models = buildTokenGoModels({
			names: ["deepseek-chat", "gpt-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
			pricing: [],
			groupRatio: 1,
			baseUrl: BASE,
		});
		expect(models.map((model) => model.id)).toEqual([
			"claude-sonnet-4-5",
			"gpt-5",
			"claude-haiku-4-5",
			"deepseek-chat",
		]);
	});
});

describe("sortByTokenGoPriority", () => {
	it("ranks by first matching priority entry and breaks ties by id", () => {
		expect(TOKEN_GO_MODEL_PRIORITY[0]).toBe("claude-sonnet-4-5");
		const sorted = sortByTokenGoPriority(
			[
				"zeta",
				"alpha",
				"gemini-2.5-pro",
				"claude-sonnet-4",
				"gpt-5",
				"gpt-5-codex",
				"claude-opus-4-5",
				"claude-sonnet-4-5-b",
				"claude-sonnet-4-5-a",
			].map((id) => ({ id })),
		);
		expect(sorted.map((entry) => entry.id)).toEqual([
			"claude-sonnet-4-5-a",
			"claude-sonnet-4-5-b",
			"claude-opus-4-5",
			"gpt-5-codex",
			"gpt-5",
			"claude-sonnet-4",
			"gemini-2.5-pro",
			"alpha",
			"zeta",
		]);
	});

	it("does not mutate its input", () => {
		const input = [{ id: "b" }, { id: "a" }];
		sortByTokenGoPriority(input);
		expect(input.map((entry) => entry.id)).toEqual(["b", "a"]);
	});
});
