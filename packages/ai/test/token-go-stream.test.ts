import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { TOKEN_GO_ENV, TOKEN_GO_PROVIDER_ID, tokenGoProvider } from "../src/providers/token-go.ts";
import type { Api, AssistantMessage, Context, Model } from "../src/types.ts";
import { type FakeTokenGo, startFakeTokenGo } from "./helpers/token-go-server.ts";

const context: Context = { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] };

function textOf(message: AssistantMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

async function setup(fake: FakeTokenGo) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(TOKEN_GO_PROVIDER_ID, async () => ({
		type: "api_key" as const,
		key: "sk-fake-1",
		env: { [TOKEN_GO_ENV.pat]: fake.pat, [TOKEN_GO_ENV.group]: "tokengo", [TOKEN_GO_ENV.baseUrl]: fake.url },
	}));
	// Issue the key the relay will accept.
	fake.tokens.push({ id: 1, name: "tokengo-cli", group: "tokengo", status: 1 });
	const models = createModels({ credentials });
	models.setProvider(tokenGoProvider({ baseUrl: fake.url }));
	await models.refresh({ providers: [TOKEN_GO_PROVIDER_ID], allowNetwork: true });
	const find = (id: string): Model<Api> => {
		const model = models.getModel(TOKEN_GO_PROVIDER_ID, id);
		if (!model) throw new Error(`missing model ${id}`);
		return model;
	};
	return { models, find };
}

function relayRequest(fake: FakeTokenGo, path: string) {
	const request = fake.requests.find((entry) => entry.path === path && entry.method === "POST");
	if (!request) throw new Error(`no request to ${path}`);
	return request;
}

describe("token-go streaming", () => {
	let fake: FakeTokenGo;

	beforeEach(async () => {
		fake = await startFakeTokenGo({ reply: "pong" });
	});

	afterEach(async () => {
		await fake.close();
	});

	it("streams anthropic-messages with x-api-key and cache usage", async () => {
		const { models, find } = await setup(fake);
		const result = await models.complete(find("claude-sonnet-4-5"), context);
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("pong");
		expect(result.usage.input).toBe(11);
		expect(result.usage.output).toBe(3);
		expect(result.usage.cacheRead).toBe(5);
		expect(result.usage.cacheWrite).toBe(2);

		const request = relayRequest(fake, "/v1/messages");
		expect(request.auth).toBe("key");
		expect(request.headers["x-api-key"]).toBe("sk-fake-1");
	});

	it("streams openai-completions with a bearer key", async () => {
		const { models, find } = await setup(fake);
		const result = await models.complete(find("deepseek-chat"), context);
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("pong");
		expect(result.usage.output).toBe(3);

		const request = relayRequest(fake, "/v1/chat/completions");
		expect(request.auth).toBe("key");
		expect(request.headers.authorization).toBe("Bearer sk-fake-1");
	});

	it("streams openai-responses with a bearer key", async () => {
		const { models, find } = await setup(fake);
		const result = await models.complete(find("gpt-5"), context);
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("pong");
		expect(result.usage.output).toBe(3);

		const request = relayRequest(fake, "/v1/responses");
		expect(request.auth).toBe("key");
		expect(request.headers.authorization).toBe("Bearer sk-fake-1");
	});

	it("aborts a stream mid-flight", async () => {
		await fake.close();
		fake = await startFakeTokenGo({ reply: "pong", holdStream: true });
		const { models, find } = await setup(fake);
		for (const id of ["claude-sonnet-4-5", "deepseek-chat", "gpt-5"]) {
			const controller = new AbortController();
			const stream = models.stream(find(id), context, { signal: controller.signal });
			let aborted = false;
			let sawText = false;
			for await (const event of stream) {
				if (event.type === "text_delta" && !aborted) {
					sawText = true;
					aborted = true;
					controller.abort();
				}
			}
			const result = await stream.result();
			expect(sawText).toBe(true);
			expect(result.stopReason).toBe("aborted");
		}
	});
});
