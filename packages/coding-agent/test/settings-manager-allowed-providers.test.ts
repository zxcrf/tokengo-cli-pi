import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DEFAULT_ALLOWED_PROVIDERS, SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager allowedProviders", () => {
	const testDir = join(process.cwd(), "test-settings-allowed-providers-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const settingsPath = join(agentDir, "settings.json");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	function managerWith(settings: Record<string, unknown>): SettingsManager {
		writeFileSync(settingsPath, JSON.stringify(settings));
		return SettingsManager.create(projectDir, agentDir);
	}

	it("defaults to token-go only", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getAllowedProviders()).toEqual(["token-go"]);
		expect(DEFAULT_ALLOWED_PROVIDERS).toEqual(["token-go"]);
	});

	it("falls back to the default when the value is not an array", () => {
		expect(managerWith({ allowedProviders: "openai" }).getAllowedProviders()).toEqual(["token-go"]);
	});

	it("filters non-string entries", () => {
		const manager = managerWith({ allowedProviders: ["openai", 3, null, "token-go"] });
		expect(manager.getAllowedProviders()).toEqual(["openai", "token-go"]);
	});

	it("honours an empty array literally", () => {
		expect(managerWith({ allowedProviders: [] }).getAllowedProviders()).toEqual([]);
	});

	it("ignores project settings", () => {
		writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ allowedProviders: ["*"] }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getAllowedProviders()).toEqual(["token-go"]);
	});

	it("persists setAllowedProviders and resets with undefined", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setAllowedProviders(["*"]);
		await manager.flush();
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).allowedProviders).toEqual(["*"]);
		expect(manager.getAllowedProviders()).toEqual(["*"]);

		manager.setAllowedProviders(undefined);
		await manager.flush();
		expect(manager.getAllowedProviders()).toEqual(["token-go"]);
	});

	it("disables install telemetry by default", () => {
		expect(SettingsManager.create(projectDir, agentDir).getEnableInstallTelemetry()).toBe(false);
		expect(managerWith({ enableInstallTelemetry: true }).getEnableInstallTelemetry()).toBe(true);
	});
});
