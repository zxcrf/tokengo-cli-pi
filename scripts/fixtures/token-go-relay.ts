/**
 * Local TokenGo/NewAPI relay for contract tests and manual CLI checks.
 *
 * The fixture deliberately has no dependency on the TokenGo provider. It can
 * be started before the provider is implemented and reused by provider,
 * coding-agent, or CLI integration tests.
 */

export interface TokenGoFakeUser {
	id: number;
	username: string;
	display_name?: string;
	group?: string;
	quota?: number;
	used_quota?: number;
}

export interface TokenGoFakeGroup {
	ratio: number | string;
	desc?: string;
}

export interface TokenGoFakePricing {
	model_name: string;
	quota_type: number;
	model_ratio?: number;
	completion_ratio?: number;
	cache_ratio?: number;
	create_cache_ratio?: number;
	supported_endpoint_types?: string[];
}

export interface TokenGoFakeRequest {
	method: string;
	path: string;
	auth: "pat" | "key" | "none";
	body: unknown;
	headers: Record<string, string | undefined>;
}

export interface StartTokenGoRelayOptions {
	pat?: string;
	relayKey?: string;
	models?: readonly string[];
	pricing?: readonly TokenGoFakePricing[];
	groups?: Record<string, TokenGoFakeGroup>;
	groupRatio?: Record<string, number>;
	pricingStatus?: 200 | 401 | 403 | 404 | 500;
	user?: Partial<TokenGoFakeUser>;
	reply?: string;
	holdStream?: boolean;
}

export interface TokenGoFakeRelay {
	url: string;
	pat: string;
	relayKey: string;
	models: readonly string[];
	pricing: readonly TokenGoFakePricing[];
	calls: string[];
	requests: TokenGoFakeRequest[];
	tokens: readonly { id: number; name: string; group: string; status: number }[];
	close(): void;
}

/** Compatibility names used by provider tests that embed this fixture. */
export type FakeTokenGoOptions = StartTokenGoRelayOptions;
export type FakeTokenGoRequest = TokenGoFakeRequest;
export type FakeTokenGo = TokenGoFakeRelay;

export const FAKE_TOKEN_GO_PAT = "pat-test";
export const FAKE_TOKEN_GO_RELAY_KEY = "sk-fake-1";

export const FAKE_TOKEN_GO_MODELS: readonly string[] = [
	"claude-sonnet-4-5",
	"claude-haiku-4-5",
	"gpt-5",
	"deepseek-chat",
	"text-embedding-3-small",
];

export const FAKE_TOKEN_GO_PRICING: readonly TokenGoFakePricing[] = [
	{
		model_name: "claude-sonnet-4-5",
		quota_type: 0,
		model_ratio: 1.5,
		completion_ratio: 5,
		supported_endpoint_types: ["anthropic", "openai"],
	},
	{
		model_name: "claude-haiku-4-5",
		quota_type: 0,
		model_ratio: 0.5,
		completion_ratio: 5,
		supported_endpoint_types: ["anthropic", "openai"],
	},
	{
		model_name: "gpt-5",
		quota_type: 0,
		model_ratio: 0.625,
		completion_ratio: 8,
		supported_endpoint_types: ["openai", "openai-response"],
	},
	{
		model_name: "deepseek-chat",
		quota_type: 0,
		model_ratio: 0.135,
		completion_ratio: 4,
		supported_endpoint_types: ["openai"],
	},
	{
		model_name: "text-embedding-3-small",
		quota_type: 0,
		model_ratio: 0.01,
		supported_endpoint_types: ["embeddings"],
	},
];

const USAGE = { input: 11, output: 3, cacheRead: 5, cacheWrite: 2 } as const;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function ok(data: unknown, extra: Record<string, unknown> = {}): Response {
	return json(200, { success: true, message: "", data, ...extra });
}

function sse(lines: readonly string[], hold = false): Response {
	const payload = new TextEncoder().encode(`${lines.join("\n\n")}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(payload);
			if (!hold) controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: {
			"cache-control": "no-cache",
			connection: "keep-alive",
			"content-type": "text/event-stream",
		},
	});
}

function dataEvent(value: unknown): string {
	return `data: ${JSON.stringify(value)}`;
}

function event(type: string, value: unknown): string {
	return `event: ${type}\n${dataEvent(value)}`;
}

function anthropicStream(reply: string, hold = false): Response {
	return sse(
		[
			event("message_start", {
				type: "message_start",
				message: {
					id: "msg_fake",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [],
					stop_reason: null,
					usage: {
						input_tokens: USAGE.input,
						output_tokens: 1,
						cache_read_input_tokens: USAGE.cacheRead,
						cache_creation_input_tokens: USAGE.cacheWrite,
					},
				},
			}),
			event("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			event("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: reply },
			}),
			event("content_block_stop", { type: "content_block_stop", index: 0 }),
			event("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: USAGE.output },
			}),
			event("message_stop", { type: "message_stop" }),
		],
		hold,
	);
}

function chatStream(reply: string, hold = false): Response {
	return sse(
		[
			dataEvent({
				id: "chatcmpl-fake",
				object: "chat.completion.chunk",
				created: 1,
				model: "gpt-fake",
				choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
			}),
			dataEvent({
				id: "chatcmpl-fake",
				object: "chat.completion.chunk",
				created: 1,
				model: "gpt-fake",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			dataEvent({
				id: "chatcmpl-fake",
				object: "chat.completion.chunk",
				created: 1,
				model: "gpt-fake",
				choices: [],
				usage: {
					prompt_tokens: USAGE.input + USAGE.cacheRead,
					completion_tokens: USAGE.output,
					total_tokens: USAGE.input + USAGE.cacheRead + USAGE.output,
					prompt_tokens_details: { cached_tokens: USAGE.cacheRead },
				},
			}),
			"data: [DONE]",
		],
		hold,
	);
}

function responsesStream(reply: string, hold = false): Response {
	const response = (status: string, extra: Record<string, unknown> = {}) => ({
		id: "resp_fake",
		object: "response",
		created_at: 1,
		model: "gpt-5",
		status,
		output: [],
		...extra,
	});
	const item = (status: string, text: string) => ({
		id: "msg_fake",
		type: "message",
		role: "assistant",
		status,
		content: text ? [{ type: "output_text", text, annotations: [] }] : [],
	});
	const output = item("completed", reply);
	return sse(
		[
			event("response.created", { type: "response.created", response: response("in_progress") }),
			event("response.output_item.added", {
				type: "response.output_item.added",
				output_index: 0,
				item: item("in_progress", ""),
			}),
			event("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, delta: reply }),
			event("response.output_text.done", { type: "response.output_text.done", output_index: 0, text: reply }),
			event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: output }),
			event("response.completed", {
				type: "response.completed",
				response: response("completed", {
					output: [output],
					usage: {
						input_tokens: USAGE.input + USAGE.cacheRead,
						output_tokens: USAGE.output,
						total_tokens: USAGE.input + USAGE.cacheRead + USAGE.output,
						input_tokens_details: { cached_tokens: USAGE.cacheRead },
					},
				}),
			}),
		],
		hold,
	);
}

function bearer(headers: Headers): string | undefined {
	const value = headers.get("authorization");
	return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

async function readJson(request: Request): Promise<unknown> {
	if (request.method === "GET" || request.method === "HEAD") return undefined;
	const text = await request.text();
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

export function startFakeTokenGo(options: StartTokenGoRelayOptions = {}): TokenGoFakeRelay {
	const pat = options.pat ?? FAKE_TOKEN_GO_PAT;
	const relayKey = options.relayKey ?? FAKE_TOKEN_GO_RELAY_KEY;
	const models = options.models ?? FAKE_TOKEN_GO_MODELS;
	const pricing = options.pricing ?? FAKE_TOKEN_GO_PRICING;
	const groups = options.groups ?? {
		default: { ratio: 1, desc: "Default" },
		tokengo: { ratio: 0.8, desc: "TokenGo" },
	};
	const groupRatio = options.groupRatio ?? { default: 1, tokengo: 0.8 };
	const reply = options.reply ?? "pong";
	const holdStream = options.holdStream ?? false;
	const user: TokenGoFakeUser = {
		id: 7,
		username: "alice",
		group: "default",
		quota: 2_500_000,
		used_quota: 500_000,
		...options.user,
	};
	const tokens = [{ id: 1, name: "tokengo-cli", group: "tokengo", status: 1 }];
	const calls: string[] = [];
	const requests: TokenGoFakeRequest[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async request => {
			const url = new URL(request.url);
			const path = url.pathname;
			calls.push(`${request.method} ${path}${url.search}`);
			const token = bearer(request.headers);
			const apiKey = request.headers.get("x-api-key");
			const auth: TokenGoFakeRequest["auth"] =
				token === pat ? "pat" : token === relayKey || apiKey === relayKey ? "key" : "none";
			const body = await readJson(request);
			requests.push({
				method: request.method,
				path,
				auth,
				body,
				headers: Object.fromEntries(request.headers.entries()),
			});

			if (path.startsWith("/api/")) {
				if (auth !== "pat") return json(401, { success: false, message: "invalid access token" });
				if (request.method === "GET" && path === "/api/user/self") return ok(user);
				if (request.method === "GET" && path === "/api/user/self/groups") return ok(groups);
				if (request.method === "GET" && path === "/api/user/models") return ok(models);
				if (request.method === "GET" && path === "/api/pricing") {
					const status = options.pricingStatus ?? 200;
					if (status !== 200) return json(status, { success: false, message: "pricing is not available" });
					return ok(pricing, { group_ratio: groupRatio });
				}
				if (request.method === "GET" && path === "/api/token/") {
					return ok({
						page: Number(url.searchParams.get("p") ?? 1),
						page_size: 100,
						total: tokens.length,
						items: tokens,
					});
				}
				if (request.method === "POST" && path === "/api/token/1/key") return ok({ key: relayKey });
				if (request.method === "POST" && path === "/api/token/") return ok(null);
				return json(404, { success: false, message: "not found" });
			}

			if (path.startsWith("/v1/")) {
				if (auth !== "key") return json(401, { error: { type: "new_api_error", message: "Invalid token" } });
				if (request.method === "GET" && path === "/v1/models") {
					return json(200, { object: "list", data: models.map(id => ({ id, object: "model" })) });
				}
				const stream = typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;
				if (request.method === "POST" && path === "/v1/messages") {
					if (stream) return anthropicStream(reply, holdStream);
					return json(200, {
						id: "msg_fake",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-5",
						content: [{ type: "text", text: reply }],
						stop_reason: "end_turn",
						usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
					});
				}
				if (request.method === "POST" && path === "/v1/chat/completions") {
					if (stream) return chatStream(reply, holdStream);
					return json(200, {
						id: "chatcmpl-fake",
						object: "chat.completion",
						choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
						usage: {
							prompt_tokens: USAGE.input,
							completion_tokens: USAGE.output,
							total_tokens: USAGE.input + USAGE.output,
						},
					});
				}
				if (request.method === "POST" && path === "/v1/responses") {
					if (stream) return responsesStream(reply, holdStream);
					return json(200, {
						id: "resp_fake",
						object: "response",
						status: "completed",
						model: "gpt-5",
						output: [
							{
								id: "msg_fake",
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: reply, annotations: [] }],
							},
						],
						usage: {
							input_tokens: USAGE.input,
							output_tokens: USAGE.output,
							total_tokens: USAGE.input + USAGE.output,
						},
					});
				}
			}
			return json(404, { error: { type: "new_api_error", message: "not found" } });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		pat,
		relayKey,
		models,
		pricing,
		calls,
		requests,
		tokens,
		close: () => server.stop(true),
	};
}
