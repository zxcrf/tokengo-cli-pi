import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { tokenGoModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/token-go";

describe("TokenGo model discovery", () => {
	test("uses /v1/models as authority and tolerates pricing denial", async () => {
		const calls: string[] = [];
		const options = tokenGoModelManagerOptions({
			apiKey: "sk-server",
			baseUrl: "http://token-go.test/v1",
			fetch: async (input, init) => {
				const url = String(input);
				calls.push(url);
				if (url.endsWith("/v1/models")) {
					return new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-4-5" },
								{ id: "gpt-5-codex" },
								{ id: "qwen-3" },
								{ id: "text-embedding-3-small", supported_endpoint_types: ["embedding"] },
							],
						}),
						{ status: 200 },
					);
				}
				if (url.endsWith("/api/pricing")) return new Response("forbidden", { status: 403 });
				throw new Error(`unexpected URL ${url} ${init?.method ?? "GET"}`);
			},
		});
		const models = await options.fetchDynamicModels?.();
		if (!models) throw new Error("TokenGo discovery unexpectedly returned no models");
		expect(models.map(model => [model.id, model.api, model.baseUrl])).toEqual([
			["claude-sonnet-4-5", "anthropic-messages", "http://token-go.test"],
			["gpt-5-codex", "openai-responses", "http://token-go.test/v1"],
			["qwen-3", "openai-completions", "http://token-go.test/v1"],
		]);
		expect(calls).toEqual(["http://token-go.test/v1/models", "http://token-go.test/api/pricing"]);
	});

	test("propagates a failed /v1 response so model-manager cache is preserved", async () => {
		const options = tokenGoModelManagerOptions({
			apiKey: "sk-server",
			baseUrl: "http://token-go.test",
			fetch: async () => new Response(JSON.stringify({ error: "upstream" }), { status: 503 }),
		});
		await expect(options.fetchDynamicModels?.()).rejects.toThrow("HTTP 503");
	});

	test("applies the configured group ratio to TokenGo pricing", async () => {
		const options = tokenGoModelManagerOptions({
			apiKey: "sk-server",
			baseUrl: "http://token-go.test",
			fetch: async input => {
				const url = String(input);
				if (url.endsWith("/v1/models")) {
					return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 });
				}
				return new Response(
					JSON.stringify({
						data: [{ model_name: "gpt-5", quota_type: 0, model_ratio: 2, completion_ratio: 5 }],
						group_ratio: { tokengo: 0.8 },
					}),
					{ status: 200 },
				);
			},
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.[0]?.cost).toEqual({ input: 3.2, output: 16, cacheRead: 3.2, cacheWrite: 4 });
	});

	test("inherits canonical capabilities and applies TokenGo GPT limits", async () => {
		const options = tokenGoModelManagerOptions({
			apiKey: "sk-server",
			baseUrl: "http://token-go.test",
			fetch: async input => {
				const url = String(input);
				if (url.endsWith("/v1/models")) {
					return new Response(
						JSON.stringify({
							data: [
								{ id: "gpt-6-astra", supported_endpoint_types: ["openai", "openai-response"] },
								{ id: "claude-haiku-4-5", supported_endpoint_types: ["anthropic", "openai"] },
								{ id: "gemini-3.1-pro", supported_endpoint_types: ["openai"] },
							],
						}),
						{ status: 200 },
					);
				}
				return new Response("forbidden", { status: 403 });
			},
		});
		const models = await options.fetchDynamicModels?.();
		if (!models) throw new Error("TokenGo discovery unexpectedly returned no models");
		const astra = models.find(model => model.id === "gpt-6-astra");
		const haiku = models.find(model => model.id === "claude-haiku-4-5");
		const gemini = models.find(model => model.id === "gemini-3.1-pro");
		expect(astra).toMatchObject({
			api: "openai-responses",
			contextWindow: 272_000,
			maxTokens: 128_000,
			reasoning: true,
			input: ["text", "image"],
		});
		expect(astra?.thinking?.efforts.length).toBeGreaterThanOrEqual(4);
		expect(haiku).toMatchObject({
			api: "anthropic-messages",
			contextWindow: 200_000,
			maxTokens: 64_000,
			reasoning: true,
			input: ["text", "image"],
		});
		expect(gemini).toMatchObject({
			api: "openai-completions",
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			reasoning: true,
			input: ["text", "image"],
		});
		const builtAstra = buildModel(astra!);
		expect(builtAstra.contextWindow).toBe(272_000);
	});

	test("keeps the complete reviewed TokenGo roster richly described", async () => {
		const expected: Record<string, [number, number]> = {
			"claude-fable-5": [1_000_000, 128_000],
			"claude-fable-5-1": [1_000_000, 128_000],
			"claude-haiku-4-5": [200_000, 64_000],
			"claude-opus-4-8": [1_000_000, 128_000],
			"claude-opus-5": [1_000_000, 128_000],
			"claude-opus-5-5": [1_000_000, 128_000],
			"claude-sonnet-5": [1_000_000, 128_000],
			"claude-sonnet-5-5": [1_000_000, 128_000],
			"deepseek-flash": [1_000_000, 384_000],
			"gemini-3.1-pro": [1_048_576, 65_536],
			"gemini-3.1-pro-preview": [1_048_576, 65_536],
			"gemini-3.6-flash": [1_048_576, 65_536],
			"gemini-3.7-flash": [1_048_576, 65_536],
			"gemini-3.8-flash": [1_048_576, 65_536],
			"gpt-5.5": [272_000, 128_000],
			"gpt-5.6-sol": [272_000, 128_000],
			"gpt-5.6-terra": [272_000, 128_000],
			"gpt-6-astra": [272_000, 128_000],
			"gpt-6-sol": [272_000, 128_000],
			"gpt-6.1-sol": [272_000, 128_000],
			"grok-4.5": [500_000, 500_000],
			"grok-4.6": [500_000, 500_000],
			"grok-4.7": [500_000, 500_000],
		};
		const options = tokenGoModelManagerOptions({
			apiKey: "sk-server",
			baseUrl: "http://token-go.test",
			fetch: async input => {
				const url = String(input);
				if (url.endsWith("/api/pricing")) return new Response("forbidden", { status: 403 });
				return new Response(
					JSON.stringify({
						data: Object.keys(expected).map(id => ({
							id,
							supported_endpoint_types: id.startsWith("claude")
								? ["anthropic", "openai"]
								: id.startsWith("gpt-") || id.startsWith("grok-")
									? ["openai", "openai-response"]
									: ["openai"],
						})),
					}),
					{ status: 200 },
				);
			},
		});
		const models = await options.fetchDynamicModels?.();
		if (!models) throw new Error("TokenGo discovery unexpectedly returned no models");
		expect(models).toHaveLength(Object.keys(expected).length);
		for (const [id, [contextWindow, maxTokens]] of Object.entries(expected)) {
			const model = models.find(candidate => candidate.id === id);
			expect(model, id).toMatchObject({ contextWindow, maxTokens, reasoning: true, input: ["text", "image"] });
			expect(model?.thinking?.efforts.length, id).toBeGreaterThan(0);
		}
	});
});
