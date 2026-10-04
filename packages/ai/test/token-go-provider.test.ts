import { describe, expect, test } from "bun:test";
import {
	TOKEN_GO_BASE_URL,
	createTokenGoClient,
	discoverTokenGoModels,
	provisionTokenGoCredential,
	tokenGoInferenceUrl,
	tokenGoRootUrl,
} from "@oh-my-pi/pi-ai/providers/token-go";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("TokenGo provider client", () => {
	test("registers API-key auth and normalizes discovery roots", () => {
		const provider = getProviderDefinition("token-go");
		if (!provider?.prepareModelDiscovery) throw new Error("TokenGo provider is not registered");
		expect(provider.envKeys).toBe("TOKENGO_API_KEY");
		expect(provider.prepareModelDiscovery({ apiKey: "sk-test", baseUrl: `${TOKEN_GO_BASE_URL}/v1` })).toEqual({
			apiKey: "sk-test",
			baseUrl: TOKEN_GO_BASE_URL,
			authenticated: true,
		});
	});

	test("normalizes account and inference URLs without leaking PATs", async () => {
		expect(tokenGoRootUrl(`${TOKEN_GO_BASE_URL}/v1/`)).toBe(TOKEN_GO_BASE_URL);
		expect(tokenGoInferenceUrl(TOKEN_GO_BASE_URL)).toBe(`${TOKEN_GO_BASE_URL}/v1`);

		const seen: Request[] = [];
		const client = createTokenGoClient({
			baseUrl: `${TOKEN_GO_BASE_URL}/v1`,
			pat: "pat-secret",
			fetch: async (input, init) => {
				seen.push(new Request(String(input), init));
				return response({ success: true, data: { id: 7, username: "alice" } });
			},
		});

		await expect(client.self()).resolves.toMatchObject({ id: 7, username: "alice" });
		expect(seen[0]?.url).toBe(`${TOKEN_GO_BASE_URL}/api/user/self`);
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer pat-secret");

		const failing = createTokenGoClient({
			baseUrl: TOKEN_GO_BASE_URL,
			pat: "pat-secret",
			fetch: async () => response({ success: false, message: "unauthorized pat-secret" }, 401),
		});
		await expect(failing.self()).rejects.toThrow("unauthorized [redacted]");
		await expect(failing.self()).rejects.not.toThrow("pat-secret");
	});

	test("combines entitlement and pricing endpoints and selects request protocols", async () => {
		const client = createTokenGoClient({
			baseUrl: TOKEN_GO_BASE_URL,
			pat: "pat",
			fetch: async input => {
				const url = String(input);
				if (url.endsWith("/api/user/models?group=tokengo")) {
					return response({
						success: true,
						data: ["claude-sonnet-4-5", "gpt-5-codex", "qwen-3", "text-embedding-3-small"],
					});
				}
				if (url.endsWith("/api/pricing")) {
					return response({
						success: true,
						data: [
							{
								model_name: "claude-sonnet-4-5",
								quota_type: 0,
								model_ratio: 2,
								supported_endpoint_types: ["anthropic"],
							},
							{
								model_name: "gpt-5-codex",
								quota_type: 0,
								model_ratio: 1,
								supported_endpoint_types: ["openai-response"],
							},
							{
								model_name: "text-embedding-3-small",
								quota_type: 0,
								supported_endpoint_types: ["embeddings"],
							},
						],
						group_ratio: { tokengo: 1.5 },
					});
				}
				throw new Error(`unexpected URL ${url}`);
			},
		});

		await expect(discoverTokenGoModels(client, "tokengo")).resolves.toEqual([
			{
				id: "claude-sonnet-4-5",
				api: "anthropic-messages",
				baseUrl: TOKEN_GO_BASE_URL,
				pricing: expect.objectContaining({ model_ratio: 2 }),
			},
			{
				id: "gpt-5-codex",
				api: "openai-responses",
				baseUrl: `${TOKEN_GO_BASE_URL}/v1`,
				pricing: expect.objectContaining({ model_ratio: 1 }),
			},
			{ id: "qwen-3", api: "openai-completions", baseUrl: `${TOKEN_GO_BASE_URL}/v1` },
		]);
	});

	test("provisioning only returns non-secret metadata alongside the inference key", async () => {
		const calls: string[] = [];
		let created = false;
		const client = createTokenGoClient({
			baseUrl: TOKEN_GO_BASE_URL,
			pat: "pat-secret",
			fetch: async (input, init) => {
				const request = new Request(String(input), init);
				calls.push(`${request.method} ${request.url}`);
				if (request.url.endsWith("/api/user/self"))
					return response({ success: true, data: { id: 9, username: "alice" } });
				if (request.url.includes("/api/token/?")) {
					return response({
						success: true,
						data: created
							? { items: [{ id: 99, name: "tokengo-cli", group: "tokengo", status: 1 }] }
							: { items: [], total: 0 },
					});
				}
				if (request.url.endsWith("/api/token/")) {
					created = true;
					return response({ success: true, data: {} });
				}
				if (request.url.endsWith("/api/token/99/key"))
					return response({ success: true, data: { key: "sk-server" } });
				throw new Error(`unexpected URL ${request.url}`);
			},
		});

		const provisioned = await provisionTokenGoCredential({
			client,
			baseUrl: `${TOKEN_GO_BASE_URL}/v1`,
			group: "tokengo",
			user: { id: 9, username: "alice" },
		});
		expect(provisioned).toEqual({
			apiKey: "sk-server",
			metadata: { baseUrl: TOKEN_GO_BASE_URL, group: "tokengo", username: "alice", userId: "9" },
		});
		expect(JSON.stringify(provisioned.metadata)).not.toContain("pat-secret");
		expect(calls).toContain(`POST ${TOKEN_GO_BASE_URL}/api/token/99/key`);
	});
});
