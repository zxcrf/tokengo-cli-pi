/**
 * In-process fake of a TokenGo (NewAPI) relay: dashboard API (PAT) plus the
 * Anthropic / OpenAI relay routes (issued sk key). Listens on 127.0.0.1:0.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { TokenGoGroup, TokenGoPricing, TokenGoUser } from "../../src/providers/token-go-client.ts";

export const FAKE_TOKEN_GO_PAT = "pat-test";

export const FAKE_TOKEN_GO_MODELS: readonly string[] = [
	"claude-sonnet-4-5",
	"claude-haiku-4-5",
	"gpt-5",
	"deepseek-chat",
	"text-embedding-3-small",
];

export const FAKE_TOKEN_GO_PRICING: readonly TokenGoPricing[] = [
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

export interface FakeTokenGoOptions {
	pat?: string;
	groups?: Record<string, TokenGoGroup>;
	models?: readonly string[];
	pricing?: readonly TokenGoPricing[];
	/** Default `{ default: 1, tokengo: 0.8 }`. */
	groupRatio?: Record<string, number>;
	/** Status of `GET /api/pricing`. Default 200. */
	pricingStatus?: 200 | 401 | 403 | 404 | 500;
	user?: Partial<TokenGoUser>;
	/** Streamed assistant text. Default "pong". */
	reply?: string;
	/** Relay streams send the first text delta, then stay open until the client disconnects. */
	holdStream?: boolean;
}

export interface FakeTokenGoRequest {
	method: string;
	path: string;
	auth: "pat" | "key" | "none";
	body: unknown;
	headers: Record<string, string | string[] | undefined>;
}

export interface FakeTokenGo {
	url: string;
	pat: string;
	calls: string[];
	requests: FakeTokenGoRequest[];
	tokens: { id: number; name: string; group: string; status: number }[];
	close(): Promise<void>;
}

const USAGE = { input: 11, output: 3, cacheRead: 5, cacheWrite: 2 };

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text) return resolve(undefined);
			try {
				resolve(JSON.parse(text));
			} catch {
				resolve(text);
			}
		});
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function sseHead(res: ServerResponse): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
}

export async function startFakeTokenGo(options: FakeTokenGoOptions = {}): Promise<FakeTokenGo> {
	const pat = options.pat ?? FAKE_TOKEN_GO_PAT;
	const reply = options.reply ?? "pong";
	const groups = options.groups ?? {
		default: { ratio: 1, desc: "Default" },
		tokengo: { ratio: 0.8, desc: "TokenGo" },
	};
	const groupRatio = options.groupRatio ?? { default: 1, tokengo: 0.8 };
	const user: TokenGoUser = {
		id: 7,
		username: "alice",
		group: "default",
		quota: 2_500_000,
		used_quota: 500_000,
		...options.user,
	};
	const tokens: FakeTokenGo["tokens"] = [];
	const calls: string[] = [];
	const requests: FakeTokenGoRequest[] = [];
	const sockets = new Set<Socket>();

	const ok = (res: ServerResponse, data: unknown, extra: Record<string, unknown> = {}) =>
		sendJson(res, 200, { success: true, message: "", data, ...extra });

	function bearer(req: IncomingMessage): string | undefined {
		const header = req.headers.authorization;
		return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
	}

	function issuedKey(value: string | undefined): boolean {
		const match = value ? /^sk-fake-(\d+)$/.exec(value) : null;
		return !!match && tokens.some((token) => token.id === Number(match[1]));
	}

	function relayAuthorized(req: IncomingMessage): boolean {
		const apiKey = req.headers["x-api-key"];
		return issuedKey(bearer(req)) || issuedKey(typeof apiKey === "string" ? apiKey : undefined);
	}

	function streamAnthropic(res: ServerResponse): void {
		sseHead(res);
		const send = (type: string, data: Record<string, unknown>) =>
			res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		send("message_start", {
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
		});
		send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		const half = Math.ceil(reply.length / 2);
		send("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.slice(0, half) } });
		if (options.holdStream) return;
		if (reply.length > half) {
			send("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.slice(half) } });
		}
		send("content_block_stop", { index: 0 });
		send("message_delta", {
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: USAGE.output },
		});
		send("message_stop", {});
		res.end();
	}

	function streamChat(res: ServerResponse): void {
		sseHead(res);
		const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
			res.write(
				`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "gpt-fake", choices, ...extra })}\n\n`,
			);
		chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
		const half = Math.ceil(reply.length / 2);
		chunk([{ index: 0, delta: { content: reply.slice(0, half) }, finish_reason: null }]);
		if (options.holdStream) return;
		if (reply.length > half) chunk([{ index: 0, delta: { content: reply.slice(half) }, finish_reason: null }]);
		chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
		chunk([], {
			usage: {
				prompt_tokens: USAGE.input + USAGE.cacheRead,
				completion_tokens: USAGE.output,
				total_tokens: USAGE.input + USAGE.cacheRead + USAGE.output,
				prompt_tokens_details: { cached_tokens: USAGE.cacheRead },
			},
		});
		res.write("data: [DONE]\n\n");
		res.end();
	}

	function streamResponses(res: ServerResponse): void {
		sseHead(res);
		let seq = 0;
		const send = (type: string, data: Record<string, unknown>) =>
			res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
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
		send("response.created", { response: response("in_progress") });
		send("response.output_item.added", { output_index: 0, item: item("in_progress", "") });
		send("response.content_part.added", {
			output_index: 0,
			item_id: "msg_fake",
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		});
		const half = Math.ceil(reply.length / 2);
		send("response.output_text.delta", {
			output_index: 0,
			item_id: "msg_fake",
			content_index: 0,
			delta: reply.slice(0, half),
		});
		if (options.holdStream) return;
		if (reply.length > half) {
			send("response.output_text.delta", {
				output_index: 0,
				item_id: "msg_fake",
				content_index: 0,
				delta: reply.slice(half),
			});
		}
		send("response.output_text.done", { output_index: 0, item_id: "msg_fake", content_index: 0, text: reply });
		send("response.content_part.done", {
			output_index: 0,
			item_id: "msg_fake",
			content_index: 0,
			part: { type: "output_text", text: reply, annotations: [] },
		});
		send("response.output_item.done", { output_index: 0, item: item("completed", reply) });
		send("response.completed", {
			response: response("completed", {
				output: [item("completed", reply)],
				usage: {
					input_tokens: USAGE.input + USAGE.cacheRead,
					output_tokens: USAGE.output,
					total_tokens: USAGE.input + USAGE.cacheRead + USAGE.output,
					input_tokens_details: { cached_tokens: USAGE.cacheRead },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			}),
		});
		res.end();
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const method = req.method ?? "GET";
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;
		const body = await readBody(req);
		calls.push(`${method} ${path}${url.search}`);
		const token = bearer(req);
		const auth: FakeTokenGoRequest["auth"] = token === pat ? "pat" : relayAuthorized(req) ? "key" : "none";
		requests.push({ method, path, auth, body, headers: { ...req.headers } });

		if (path.startsWith("/api/")) {
			if (auth !== "pat") {
				return sendJson(res, 401, { success: false, message: "invalid access token" });
			}
			if (method === "GET" && path === "/api/user/self") return ok(res, user);
			if (method === "GET" && path === "/api/user/self/groups") return ok(res, groups);
			if (method === "GET" && path === "/api/user/models") return ok(res, options.models ?? FAKE_TOKEN_GO_MODELS);
			if (method === "GET" && path === "/api/pricing") {
				const status = options.pricingStatus ?? 200;
				if (status !== 200) return sendJson(res, status, { success: false, message: "pricing is not available" });
				return ok(res, options.pricing ?? FAKE_TOKEN_GO_PRICING, { group_ratio: groupRatio });
			}
			if (method === "GET" && path === "/api/token/") {
				const page = Math.max(1, Number(url.searchParams.get("p")) || 1);
				const size = Math.max(1, Number(url.searchParams.get("size")) || 10);
				return ok(res, {
					page,
					page_size: size,
					total: tokens.length,
					items: tokens.slice((page - 1) * size, page * size),
				});
			}
			if (method === "POST" && path === "/api/token/") {
				const input = body as { name: string; group: string };
				tokens.push({
					id: Math.max(0, ...tokens.map((token) => token.id)) + 1,
					name: input.name,
					group: input.group,
					status: 1,
				});
				return ok(res, null);
			}
			const key = /^\/api\/token\/(\d+)\/key$/.exec(path);
			if (method === "POST" && key) return ok(res, { key: `sk-fake-${key[1]}` });
			return sendJson(res, 404, { success: false, message: "not found" });
		}

		if (path.startsWith("/v1/")) {
			if (!relayAuthorized(req)) {
				return sendJson(res, 401, { error: { type: "new_api_error", message: "Invalid token" } });
			}
			const stream = typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;
			if (method === "GET" && path === "/v1/models") {
				return sendJson(res, 200, {
					object: "list",
					data: (options.models ?? FAKE_TOKEN_GO_MODELS).map((id) => ({ id, object: "model" })),
				});
			}
			if (method === "POST" && path === "/v1/messages") {
				if (stream) return streamAnthropic(res);
				return sendJson(res, 200, {
					id: "msg_fake",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [{ type: "text", text: reply }],
					stop_reason: "end_turn",
					usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
				});
			}
			if (method === "POST" && path === "/v1/chat/completions") {
				if (stream) return streamChat(res);
				return sendJson(res, 200, {
					id: "chatcmpl-fake",
					object: "chat.completion",
					created: 1,
					model: "gpt-fake",
					choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
					usage: {
						prompt_tokens: USAGE.input,
						completion_tokens: USAGE.output,
						total_tokens: USAGE.input + USAGE.output,
					},
				});
			}
			if (method === "POST" && path === "/v1/responses") {
				if (stream) return streamResponses(res);
				return sendJson(res, 200, {
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
		sendJson(res, 404, { error: { type: "new_api_error", message: "not found" } });
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			if (!res.headersSent) sendJson(res, 500, { success: false, message: String(error) });
			else res.end();
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}`,
		pat,
		calls,
		requests,
		tokens,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
			}),
	};
}
