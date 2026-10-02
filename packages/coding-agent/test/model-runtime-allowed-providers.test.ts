import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const SELF_REFRESH_ID = "self-refresh";
const selfRefreshModels = vi.fn(async (_context: unknown) => []);

vi.mock("@earendil-works/pi-ai/providers/all", async (importOriginal) => {
	const original = await importOriginal<typeof import("@earendil-works/pi-ai/providers/all")>();
	const selfRefreshing: Provider = {
		id: "self-refresh",
		name: "Self refresh",
		auth: { apiKey: { name: "key", resolve: async () => undefined } },
		getModels: () => [],
		refreshModels: (context: unknown) => selfRefreshModels(context),
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	} as unknown as Provider;
	return { ...original, builtinProviders: () => [...original.builtinProviders(), selfRefreshing] };
});

function nativeProvider(id: string): Provider<"openai-completions"> {
	const model: Model<"openai-completions"> = {
		id: "m",
		name: "m",
		api: "openai-completions",
		provider: id,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	return {
		id,
		name: id,
		auth: { apiKey: { name: "key", resolve: async () => undefined } },
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

describe("ModelRuntime allowedBuiltinProviders", () => {
	let dir: string;
	let allBuiltinIds: string[];

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "model-runtime-allowed-"));
		const all = await create({});
		allBuiltinIds = all.getProviders().map((provider) => provider.id);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function create(options: { allowed?: readonly string[]; modelsJson?: object }): Promise<ModelRuntime> {
		let modelsPath: string | null = null;
		if (options.modelsJson) {
			modelsPath = join(dir, "models.json");
			mkdirSync(dir, { recursive: true });
			writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
		}
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath,
			allowModelNetwork: false,
			allowedBuiltinProviders: options.allowed,
		});
	}

	function ids(runtime: ModelRuntime): string[] {
		return runtime.getProviders().map((provider) => provider.id);
	}

	it("exposes every built-in provider when undefined", async () => {
		const runtime = await create({});
		expect(ids(runtime)).toContain("openai");
		expect(ids(runtime)).toContain("anthropic");
		expect(ids(runtime)).toContain(SELF_REFRESH_ID);
	});

	it("keeps exactly the listed built-ins", async () => {
		const runtime = await create({ allowed: [SELF_REFRESH_ID, "openai"] });
		expect(ids(runtime).sort()).toEqual(["openai", SELF_REFRESH_ID].sort());
		expect(runtime.getModels("anthropic")).toEqual([]);
	});

	it('treats "*" as all built-ins', async () => {
		const runtime = await create({ allowed: ["*"] });
		expect(ids(runtime).sort()).toEqual([...allBuiltinIds].sort());
	});

	it('treats "*" next to other ids as all built-ins', async () => {
		const runtime = await create({ allowed: [SELF_REFRESH_ID, "*"] });
		expect(ids(runtime).sort()).toEqual([...allBuiltinIds].sort());
	});

	it("honours an empty list literally", async () => {
		const runtime = await create({ allowed: [] });
		expect(ids(runtime)).toEqual([]);
	});

	it("keeps models.json custom providers", async () => {
		const runtime = await create({
			allowed: [],
			modelsJson: {
				providers: {
					"my-proxy": {
						baseUrl: "https://proxy.test/v1",
						apiKey: "k",
						api: "openai-completions",
						models: [{ id: "custom-model" }],
					},
				},
			},
		});
		expect(ids(runtime)).toEqual(["my-proxy"]);
		expect(runtime.getModels("my-proxy").map((model) => model.id)).toEqual(["custom-model"]);
	});

	it("keeps native extension providers", async () => {
		const runtime = await create({ allowed: [] });
		runtime.registerNativeProvider(nativeProvider("ext-native"));
		expect(ids(runtime)).toEqual(["ext-native"]);
	});

	it("turns a models.json entry for a hidden built-in into a custom provider", async () => {
		const runtime = await create({
			allowed: [],
			modelsJson: {
				providers: {
					openai: {
						baseUrl: "https://proxy.test/v1",
						apiKey: "k",
						api: "openai-completions",
						models: [{ id: "only-model" }],
						modelOverrides: { "gpt-5.5": { name: "Renamed" } },
					},
				},
			},
		});
		expect(ids(runtime)).toEqual(["openai"]);
		expect(runtime.getModels("openai").map((model) => model.id)).toEqual(["only-model"]);
	});

	it("does not crash on an overrides-only models.json entry for a hidden built-in", async () => {
		const runtime = await create({
			allowed: [],
			modelsJson: { providers: { openai: { modelOverrides: { "gpt-5.5": { name: "Renamed" } } } } },
		});
		expect(runtime.getModels("openai")).toEqual([]);
		expect(runtime.getModels("anthropic")).toEqual([]);
	});

	it("does not wrap a provider that defines its own refreshModels", async () => {
		const runtime = await create({ allowed: [SELF_REFRESH_ID, "openai"] });
		const refreshing = runtime.getProvider(SELF_REFRESH_ID);
		expect(refreshing).toBeDefined();
		await refreshing?.refreshModels?.({ signal: new AbortController().signal } as never);
		expect(selfRefreshModels).toHaveBeenCalled();
	});
});
