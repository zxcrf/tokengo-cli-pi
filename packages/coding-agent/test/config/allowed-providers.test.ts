import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { allowedProviderIds, cfgAllowedProviders, providerMatchesAllowedList } from "../../src/config/model-settings";

describe("allowed provider policy", () => {
	test("keeps the SDK registry unrestricted without CLI settings", () => {
		expect(allowedProviderIds()).toEqual(["*"]);
	});

	test("defaults CLI settings to TokenGo and supports an explicit wildcard", () => {
		const settings = Settings.isolated();
		expect(allowedProviderIds(settings)).toEqual(["token-go"]);
		cfgAllowedProviders.override(settings, ["*"]);
		expect(allowedProviderIds(settings)).toEqual(["*"]);
	});

	test("matches exact ids and provider globs", () => {
		expect(providerMatchesAllowedList("token-go", ["token-go"])).toBe(true);
		expect(providerMatchesAllowedList("token-go", ["token-go/*"])).toBe(true);
		expect(providerMatchesAllowedList("token-go/custom", ["token-go/*"])).toBe(true);
		expect(providerMatchesAllowedList("anthropic", ["token-go"])).toBe(false);
		expect(providerMatchesAllowedList("anthropic", ["*"])).toBe(true);
		expect(providerMatchesAllowedList("anthropic", [])).toBe(false);
	});
});
