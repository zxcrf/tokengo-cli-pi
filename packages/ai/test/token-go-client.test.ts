import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTokenGoClient,
	normalizeTokenGoBaseUrl,
	provisionTokenGoKey,
	quotaToUSD,
	requireTokenGoGroup,
	TOKEN_GO_AUTH_HINT,
	TOKEN_GO_BASE_URL,
	TOKEN_GO_TOKEN_NAME,
	TokenGoError,
	type TokenGoToken,
} from "../src/providers/token-go-client.ts";
import { type FakeTokenGo, startFakeTokenGo } from "./helpers/token-go-server.ts";

const SECRET_PAT = "pat-super-secret-value";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected rejection");
}

describe("token-go client against the fake server", () => {
	let fake: FakeTokenGo;

	beforeEach(async () => {
		fake = await startFakeTokenGo();
	});

	afterEach(async () => {
		await fake.close();
	});

	it("reads user, groups, models and pricing with the PAT and New-Api-User header", async () => {
		const client = createTokenGoClient({ pat: fake.pat, baseUrl: `${fake.url}/`, userId: "7" });
		expect(client.baseUrl).toBe(fake.url);
		expect((await client.self()).username).toBe("alice");
		expect(Object.keys(await client.groups())).toEqual(["default", "tokengo"]);
		expect(await client.userModels("tokengo")).toContain("claude-sonnet-4-5");
		const pricing = await client.pricingEnvelope();
		expect(pricing.group_ratio).toEqual({ default: 1, tokengo: 0.8 });
		expect(pricing.data.length).toBeGreaterThan(0);

		expect(fake.calls).toContain("GET /api/user/models?group=tokengo");
		for (const request of fake.requests) {
			expect(request.auth).toBe("pat");
			expect(request.headers["new-api-user"]).toBe("7");
		}
	});

	it("maps 401 to a TokenGoError with the auth hint and never leaks the PAT", async () => {
		const client = createTokenGoClient({ pat: SECRET_PAT, baseUrl: fake.url });
		const error = await caught(client.self());
		expect(error).toBeInstanceOf(TokenGoError);
		const failure = error as TokenGoError;
		expect(failure.status).toBe(401);
		expect(failure.hint).toBe(TOKEN_GO_AUTH_HINT);
		expect(failure.path).toBe("/api/user/self");
		for (const text of [failure.message, failure.hint, failure.path, String(failure.cause)]) {
			expect(text).not.toContain(SECRET_PAT);
		}
	});

	it("throws on pricing 401 and 403 with the hint", async () => {
		for (const status of [401, 403] as const) {
			const hidden = await startFakeTokenGo({ pricingStatus: status });
			try {
				const client = createTokenGoClient({ pat: hidden.pat, baseUrl: hidden.url });
				const failure = (await caught(client.pricingEnvelope())) as TokenGoError;
				expect(failure.status).toBe(status);
				expect(failure.hint).toBe(TOKEN_GO_AUTH_HINT);
			} finally {
				await hidden.close();
			}
		}
	});

	it("paginates tokens across pages and dedupes by id", async () => {
		for (let id = 1; id <= 250; id++) fake.tokens.push({ id, name: `t${id}`, group: "tokengo", status: 1 });
		const client = createTokenGoClient({ pat: fake.pat, baseUrl: fake.url });
		const all = await client.tokens();
		expect(all).toHaveLength(250);
		expect(new Set(all.map((token) => token.id)).size).toBe(250);
		expect(fake.calls.filter((call) => call.startsWith("GET /api/token/"))).toEqual([
			"GET /api/token/?p=1&size=100",
			"GET /api/token/?p=2&size=100",
			"GET /api/token/?p=3&size=100",
		]);
	});

	it("provisions a key: creates the cli token once, then reuses it", async () => {
		const client = createTokenGoClient({ pat: fake.pat, baseUrl: fake.url });
		const first = await provisionTokenGoKey({ client, group: "tokengo" });
		expect(first.key).toBe("sk-fake-1");
		expect(first.user.id).toBe(7);
		expect(first.group).toBe("tokengo");
		expect(fake.tokens).toEqual([{ id: 1, name: TOKEN_GO_TOKEN_NAME, group: "tokengo", status: 1 }]);
		const createBody = fake.requests.find((request) => request.method === "POST" && request.path === "/api/token/");
		expect(createBody?.body).toEqual({
			name: TOKEN_GO_TOKEN_NAME,
			group: "tokengo",
			unlimited_quota: true,
			remain_quota: 0,
			expired_time: -1,
			model_limits_enabled: false,
			model_limits: "",
			allow_ips: "",
		});

		const second = await provisionTokenGoKey({ client, group: "tokengo", user: first.user });
		expect(second.key).toBe("sk-fake-1");
		expect(fake.tokens).toHaveLength(1);
		expect(fake.calls.filter((call) => call === "POST /api/token/")).toHaveLength(1);
	});

	it("ignores disabled or other-group tokens when provisioning", async () => {
		fake.tokens.push({ id: 1, name: TOKEN_GO_TOKEN_NAME, group: "tokengo", status: 2 });
		fake.tokens.push({ id: 2, name: TOKEN_GO_TOKEN_NAME, group: "default", status: 1 });
		const client = createTokenGoClient({ pat: fake.pat, baseUrl: fake.url });
		const provisioned = await provisionTokenGoKey({ client, group: "tokengo" });
		expect(provisioned.key).toBe("sk-fake-3");
		expect(fake.tokens).toHaveLength(3);
	});

	it("allocates new token ids above the highest existing id", async () => {
		fake.tokens.push({ id: 5, name: "other", group: "default", status: 1 });
		const client = createTokenGoClient({ pat: fake.pat, baseUrl: fake.url });
		expect((await provisionTokenGoKey({ client, group: "tokengo" })).key).toBe("sk-fake-6");
	});
});

describe("token-go client envelope and transport handling", () => {
	it("rejects non-JSON bodies", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async () => new Response("<html>gateway</html>", { status: 502 }),
		});
		const failure = (await caught(client.self())) as TokenGoError;
		expect(failure).toBeInstanceOf(TokenGoError);
		expect(failure.message).toBe("TokenGo /api/user/self: unexpected response (HTTP 502)");
		expect(failure.status).toBe(502);
	});

	it("rejects success:false envelopes with the server message", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async () => jsonResponse({ success: false, message: "quota exhausted" }),
		});
		const failure = (await caught(client.self())) as TokenGoError;
		expect(failure.message).toBe("quota exhausted");
		expect(failure.status).toBe(200);
		expect(failure.hint).toBeUndefined();
	});

	it("falls back to a generic message on HTTP 500 without a message", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async () => jsonResponse({ success: false }, 500),
		});
		const failure = (await caught(client.groups())) as TokenGoError;
		expect(failure.message).toBe("TokenGo /api/user/self/groups: request failed (HTTP 500)");
		expect(failure.status).toBe(500);
		expect(failure.hint).toBeUndefined();
	});

	it("adds the auth hint on 403", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async () => jsonResponse({ success: false, message: "forbidden" }, 403),
		});
		const failure = (await caught(client.self())) as TokenGoError;
		expect(failure.hint).toBe(TOKEN_GO_AUTH_HINT);
	});

	it("wraps network failures without leaking the PAT", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async (_input, init) => {
				throw new TypeError(`fetch failed: ${String((init?.headers as Record<string, string>).Authorization)}`);
			},
		});
		const failure = (await caught(client.self())) as TokenGoError;
		expect(failure).toBeInstanceOf(TokenGoError);
		expect(failure.status).toBeUndefined();
		for (const text of [failure.message, failure.hint ?? "", failure.path, String(failure.cause)]) {
			expect(text).not.toContain(SECRET_PAT);
		}
	});

	it("rethrows the caller signal reason on abort", async () => {
		const controller = new AbortController();
		const reason = new Error("user cancelled");
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			signal: controller.signal,
			fetch: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		});
		const pending = caught(client.self());
		controller.abort(reason);
		expect(await pending).toBe(reason);
	});

	it("rethrows the caller reason when abort happens while reading the body", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled mid-body");
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			signal: controller.signal,
			fetch: async (_input, init) =>
				new Response(
					new ReadableStream({
						start(stream) {
							init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason));
						},
					}),
					{ status: 200 },
				),
		});
		const pending = caught(client.self());
		setTimeout(() => controller.abort(reason), 10);
		expect(await pending).toBe(reason);
	});

	it("reports a timeout while reading the body as a timeout", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			timeoutMs: 20,
			fetch: async (_input, init) =>
				new Response(
					new ReadableStream({
						start(stream) {
							init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason));
						},
					}),
					{ status: 200 },
				),
		});
		const failure = (await caught(client.self())) as TokenGoError;
		expect(failure).toBeInstanceOf(TokenGoError);
		expect(failure.status).toBeUndefined();
		expect(failure.message).toContain("timed out");
	});

	it("reports a timeout as a TokenGoError without status", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			timeoutMs: 20,
			fetch: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		});
		const failure = (await caught(client.self())) as TokenGoError;
		expect(failure).toBeInstanceOf(TokenGoError);
		expect(failure.status).toBeUndefined();
		expect(failure.message).toContain("timed out");
	});

	it("bounds token pagination at 50 pages when the server keeps returning fresh ids", async () => {
		let requests = 0;
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async () => {
				const base = requests * 100;
				requests++;
				const items: TokenGoToken[] = Array.from({ length: 100 }, (_, index) => ({
					id: base + index + 1,
					name: "t",
					status: 1,
				}));
				return jsonResponse({ success: true, data: { items } });
			},
		});
		const all = await client.tokens();
		expect(requests).toBe(50);
		expect(all).toHaveLength(5000);
	});

	it("stops when a server ignores p and repeats the same page", async () => {
		let requests = 0;
		const items: TokenGoToken[] = Array.from({ length: 100 }, (_, index) => ({
			id: index + 1,
			name: "t",
			status: 1,
		}));
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async () => {
				requests++;
				return jsonResponse({ success: true, data: { items } });
			},
		});
		expect(await client.tokens()).toHaveLength(100);
		expect(requests).toBe(2);
	});

	it("keeps only finite numeric group ratios in the pricing envelope", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async () => jsonResponse({ success: true, data: [], group_ratio: { a: 1, b: "x", c: null, d: 0.5 } }),
		});
		expect((await client.pricingEnvelope()).group_ratio).toEqual({ a: 1, d: 0.5 });
	});

	it("rejects malformed data shapes", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async () => jsonResponse({ success: true, data: { nope: true } }),
		});
		await expect(client.self()).rejects.toBeInstanceOf(TokenGoError);
		await expect(client.userModels("x")).rejects.toBeInstanceOf(TokenGoError);
		await expect(client.tokenKey(1)).rejects.toBeInstanceOf(TokenGoError);
	});

	it("fails provisioning when the created token cannot be found", async () => {
		const client = createTokenGoClient({
			pat: SECRET_PAT,
			fetch: async (_input, init) =>
				init?.method === "POST"
					? jsonResponse({ success: true, data: null })
					: jsonResponse({ success: true, data: { items: [] } }),
		});
		await expect(provisionTokenGoKey({ client, group: "tokengo", user: { id: 1, username: "a" } })).rejects.toThrow(
			"created but not found",
		);
	});
});

describe("token-go client helpers", () => {
	it("normalizes base URLs", () => {
		expect(normalizeTokenGoBaseUrl(undefined)).toBe(TOKEN_GO_BASE_URL);
		expect(normalizeTokenGoBaseUrl("  ")).toBe(TOKEN_GO_BASE_URL);
		expect(normalizeTokenGoBaseUrl(" http://x.test/// ")).toBe("http://x.test");
	});

	it("requires the tokengo group", () => {
		expect(requireTokenGoGroup({ tokengo: { ratio: 1 } })).toBe("tokengo");
		const error = (() => {
			try {
				requireTokenGoGroup({ default: { ratio: 1 } });
			} catch (e) {
				return e;
			}
			return undefined;
		})();
		expect(error).toBeInstanceOf(TokenGoError);
		expect((error as TokenGoError).message).toContain("https://token-go.click/wallet");
		expect((error as TokenGoError).message).toContain("tokengo login");
	});

	it("converts quota to USD", () => {
		expect(quotaToUSD(2_500_000)).toBe(5);
	});
});
