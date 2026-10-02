import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import type * as Config from "../src/config.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// First-time setup only runs for the official Pi distribution, so the distribution identity is mocked.
const distribution = vi.hoisted(() => ({ appName: "pi", configDir: ".pi" }));
vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Config>();
	return {
		...actual,
		get APP_NAME() {
			return distribution.appName;
		},
		get CONFIG_DIR_NAME() {
			return distribution.configDir;
		},
		get PACKAGE_NAME() {
			return "@earendil-works/pi-coding-agent";
		},
	};
});

describe("shouldRunFirstTimeSetup", () => {
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-first-time-setup-"));
		settingsPath = join(tempDir, "settings.json");
		process.env.PI_EXPERIMENTAL = "1";
		delete process.env[ENV_AGENT_DIR];
		distribution.appName = "pi";
		distribution.configDir = ".pi";
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("returns true when experimental, default agent dir, and no settings.json", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("returns false for a renamed distribution such as tokengo", () => {
		distribution.appName = "tokengo";
		distribution.configDir = ".tokengo";

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when experimental features are disabled", () => {
		delete process.env.PI_EXPERIMENTAL;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when a custom agent dir is set", () => {
		process.env[ENV_AGENT_DIR] = tempDir;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when settings.json already exists", () => {
		writeFileSync(settingsPath, "{}", "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});

describe("analytics settings", () => {
	it("defaults to disabled with no tracking identifier", () => {
		const manager = SettingsManager.inMemory();

		expect(manager.getEnableAnalytics()).toBe(false);
		expect(manager.getTrackingId()).toBeUndefined();
	});

	it("generates a tracking identifier on opt-in", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(true);

		expect(manager.getEnableAnalytics()).toBe(true);
		expect(manager.getTrackingId()).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("does not generate a tracking identifier on opt-out", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(false);

		expect(manager.getEnableAnalytics()).toBe(false);
		expect(manager.getTrackingId()).toBeUndefined();
	});

	it("keeps the tracking identifier when toggling analytics", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(true);
		const trackingId = manager.getTrackingId();
		manager.setEnableAnalytics(false);
		manager.setEnableAnalytics(true);

		expect(manager.getTrackingId()).toBe(trackingId);
	});
});
