import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import tokenGoExtension from "../src/extensions/token-go/index.ts";

const { selfMock, selfImpl, clientOptions, MockTokenGoError } = vi.hoisted(() => {
	class MockTokenGoError extends Error {
		hint: string | undefined;
		constructor(message: string, options: { hint?: string }) {
			super(message);
			this.hint = options.hint;
		}
	}
	const selfImpl: { current: () => Promise<unknown> } = { current: async () => undefined };
	const clientOptions: { current: Record<string, unknown> | undefined } = { current: undefined };
	return { selfMock: (): Promise<unknown> => selfImpl.current(), selfImpl, clientOptions, MockTokenGoError };
});

vi.mock("@earendil-works/pi-ai/providers/token-go", () => ({
	TOKEN_GO_PROVIDER_ID: "token-go",
	readTokenGoCredentialEnv: (env: Record<string, string> | undefined) => ({
		pat: env?.TOKENGO_PAT,
		group: env?.TOKENGO_GROUP,
		userId: env?.TOKENGO_USER_ID,
		baseUrl: env?.TOKENGO_BASE_URL,
	}),
}));

vi.mock("@earendil-works/pi-ai/providers/token-go-client", () => {
	return {
		TokenGoError: MockTokenGoError,
		quotaToUSD: (q: number) => q / 500_000,
		createTokenGoClient: (options: Record<string, unknown>) => {
			clientOptions.current = options;
			return { baseUrl: "https://relay.test", self: selfMock };
		},
	};
});

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function setup(options: { provider?: boolean; auth?: { env?: Record<string, string> } | undefined } = {}) {
	let handler: Handler | undefined;
	let name: string | undefined;
	tokenGoExtension({
		registerCommand: (n: string, o: { handler: Handler }) => {
			name = n;
			handler = o.handler;
		},
	} as unknown as ExtensionAPI);
	const notify = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		ui: { notify, setStatus },
		modelRegistry: {
			getProvider: () => (options.provider === false ? undefined : {}),
			getProviderAuth: async () => options.auth,
			getAll: () => [{ provider: "token-go" }, { provider: "token-go" }, { provider: "other" }],
		},
	} as unknown as ExtensionCommandContext;
	return { name, run: () => handler!("", ctx), notify, setStatus };
}

describe("token-go extension", () => {
	beforeEach(() => {
		selfImpl.current = async () => undefined;
		clientOptions.current = undefined;
	});

	it("registers tokengo-status", () => {
		expect(setup().name).toBe("tokengo-status");
	});

	it("warns when the provider is disabled", async () => {
		const t = setup({ provider: false });
		await t.run();
		expect(t.notify).toHaveBeenCalledWith("TokenGo provider is disabled (allowedProviders).", "warning");
	});

	it("warns when not logged in", async () => {
		const t = setup({ auth: undefined });
		await t.run();
		expect(t.notify).toHaveBeenCalledWith("Not logged in to TokenGo. Run `tokengo login`.", "warning");
	});

	it("warns when the PAT is missing", async () => {
		const t = setup({ auth: { env: {} } });
		await t.run();
		expect(t.notify).toHaveBeenCalledWith(
			"TokenGo status needs the system access token. Run `tokengo login`.",
			"warning",
		);
	});

	it("prints the account summary and sets the status", async () => {
		selfImpl.current = async () => ({
			id: 7,
			username: "alice",
			group: "default",
			quota: 2_000_000,
			used_quota: 500_000,
		});
		const t = setup({
			auth: {
				env: {
					TOKENGO_PAT: "pat-secret",
					TOKENGO_GROUP: "tokengo",
					TOKENGO_USER_ID: "7",
					TOKENGO_BASE_URL: "https://relay.test",
				},
			},
		});
		await t.run();
		const [text, level] = t.notify.mock.calls[0] as [string, string];
		expect(level).toBe("info");
		expect(text).toContain("User:     alice (#7)");
		expect(text).toContain("Group:    tokengo");
		expect(text).toContain("Balance:  $4.00 (used $1.00)");
		expect(text).toContain("Models:   2 cached");
		expect(text).toContain("Endpoint: https://relay.test");
		expect(t.setStatus).toHaveBeenCalledWith("token-go", "TokenGo $4.00");
		expect(clientOptions.current).toMatchObject({ pat: "pat-secret", baseUrl: "https://relay.test", userId: "7" });
		expect(clientOptions.current?.signal).toBeInstanceOf(AbortSignal);
		expect(text).not.toContain("pat-secret");
	});

	it("reports TokenGoError with its hint", async () => {
		selfImpl.current = async () => {
			throw new MockTokenGoError("HTTP 401", { hint: "rejected hint" });
		};
		const t = setup({ auth: { env: { TOKENGO_PAT: "pat" } } });
		await t.run();
		const [text, level] = t.notify.mock.calls[0] as [string, string];
		expect(level).toBe("error");
		expect(text).toContain("rejected hint");
		expect(t.setStatus).toHaveBeenCalledWith("token-go", undefined);
		expect(t.setStatus).not.toHaveBeenCalledWith("token-go", expect.stringContaining("$"));
	});

	it("reports other failures instead of throwing and clears the status", async () => {
		selfImpl.current = async () => {
			throw new Error("socket hang up");
		};
		const t = setup({ auth: { env: { TOKENGO_PAT: "pat-secret" } } });
		await t.run();
		expect(t.notify).toHaveBeenCalledWith("TokenGo status failed: socket hang up", "error");
		expect(t.setStatus).toHaveBeenCalledWith("token-go", undefined);
		for (const [text] of t.notify.mock.calls as [string][]) expect(text).not.toContain("pat-secret");
	});
});
