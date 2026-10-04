import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
	FAKE_TOKEN_GO_MODELS,
	FAKE_TOKEN_GO_PAT,
	startFakeTokenGo,
	type TokenGoFakeRelay,
} from "./fixtures/token-go-relay.ts";
import { readTokenGoCatalog } from "./token-go-offline-cache.ts";

let relays: TokenGoFakeRelay[] = [];

afterEach(() => {
	for (const relay of relays) relay.close();
	relays = [];
});

function relay(options: Parameters<typeof startFakeTokenGo>[0] = {}): TokenGoFakeRelay {
	const instance = startFakeTokenGo(options);
	relays.push(instance);
	return instance;
}

async function json(response: Response): Promise<Record<string, unknown>> {
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("expected object response");
	return body as Record<string, unknown>;
}

describe("TokenGo local relay contract", () => {
	it("requires PAT for dashboard calls and returns models", async () => {
		const fake = relay();
		const unauthorized = await fetch(`${fake.url}/api/user/self`);
		expect(unauthorized.status).toBe(401);

		const self = await fetch(`${fake.url}/api/user/self`, {
			headers: { Authorization: `Bearer ${FAKE_TOKEN_GO_PAT}` },
		});
		expect(self.status).toBe(200);
		expect((await json(self)).data).toMatchObject({ username: "alice" });

		const models = await fetch(`${fake.url}/api/user/models?group=tokengo`, {
			headers: { Authorization: `Bearer ${FAKE_TOKEN_GO_PAT}` },
		});
		expect((await json(models)).data).toEqual(FAKE_TOKEN_GO_MODELS);
		expect(fake.requests.map(request => request.auth)).toEqual(["none", "pat", "pat"]);
	});

	it("requires the issued relay key and serves the OpenAI model list", async () => {
		const fake = relay();
		const unauthorized = await fetch(`${fake.url}/v1/models`);
		expect(unauthorized.status).toBe(401);

		const models = await fetch(`${fake.url}/v1/models`, {
			headers: { Authorization: `Bearer ${fake.relayKey}` },
		});
		expect(models.status).toBe(200);
		expect((await json(models)).data).toEqual(FAKE_TOKEN_GO_MODELS.map(id => ({ id, object: "model" })));
	});

	it("serves Anthropic Messages, OpenAI Chat, and OpenAI Responses streams", async () => {
		const fake = relay({ reply: "pong" });
		const requests = [
			{
				path: "/v1/messages",
				headers: { "x-api-key": fake.relayKey },
				body: { model: "claude-sonnet-4-5", stream: true, messages: [{ role: "user", content: "ping" }] },
				markers: ["message_start", "content_block_delta", "pong"],
			},
			{
				path: "/v1/chat/completions",
				headers: { Authorization: `Bearer ${fake.relayKey}` },
				body: { model: "deepseek-chat", stream: true, messages: [{ role: "user", content: "ping" }] },
				markers: ["chat.completion.chunk", "[DONE]", "pong"],
			},
			{
				path: "/v1/responses",
				headers: { Authorization: `Bearer ${fake.relayKey}` },
				body: { model: "gpt-5", stream: true, input: "ping" },
				markers: ["response.created", "response.completed", "pong"],
			},
		] as const;

		for (const request of requests) {
			const response = await fetch(`${fake.url}${request.path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...request.headers },
				body: JSON.stringify(request.body),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const text = await response.text();
			for (const marker of request.markers) expect(text).toContain(marker);
		}

		expect(fake.requests.filter(request => request.path.startsWith("/v1/")).map(request => request.auth)).toEqual([
			"key",
			"key",
			"key",
		]);
	});

	it("keeps pricing failure explicit as HTTP 403", async () => {
		const fake = relay({ pricingStatus: 403 });
		const response = await fetch(`${fake.url}/api/pricing`, {
			headers: { Authorization: `Bearer ${fake.pat}` },
		});
		expect(response.status).toBe(403);
		expect((await json(response)).message).toBe("pricing is not available");
	});

	it("uses a cached model snapshot after the relay goes offline", async () => {
		const fake = relay();
		const directory = await mkdtemp(join(tmpdir(), "tokengo-cache-"));
		const cacheFile = join(directory, "models.json");
		try {
			const online = await readTokenGoCatalog({ baseUrl: fake.url, pat: fake.pat, cacheFile });
			expect(online.source).toBe("network");
			expect(online.models).toEqual(FAKE_TOKEN_GO_MODELS);
			fake.close();
			const offline = await readTokenGoCatalog({ baseUrl: fake.url, pat: fake.pat, cacheFile });
			expect(offline.source).toBe("cache");
			expect(offline.models).toEqual(FAKE_TOKEN_GO_MODELS);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
