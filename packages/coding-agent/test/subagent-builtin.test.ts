import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { discoverAgents } from "../src/extensions/subagent/agents.ts";
import { DEFAULT_AGENTS } from "../src/extensions/subagent/default-agents.ts";
import { getSubagentInvocation } from "../src/extensions/subagent/index.ts";

describe("getSubagentInvocation", () => {
	it("re-runs the current script with the current runtime", () => {
		expect(
			getSubagentInvocation(["--mode", "json"], {
				argv1: "/repo/src/cli.ts",
				execPath: "/usr/bin/node",
				fileExists: () => true,
			}),
		).toEqual({ command: "/usr/bin/node", args: ["/repo/src/cli.ts", "--mode", "json"] });
	});

	it("uses the executable for a Bun compiled binary", () => {
		expect(
			getSubagentInvocation(["-p"], {
				argv1: "/$bunfs/root/tokengo",
				execPath: "/usr/local/bin/tokengo",
				fileExists: () => true,
			}),
		).toEqual({ command: "/usr/local/bin/tokengo", args: ["-p"] });
	});

	it("uses the executable when the runtime is a Bun binary (including Windows)", () => {
		expect(
			getSubagentInvocation(["-p"], {
				argv1: "B:\\~BUN\\root\\tokengo.exe",
				execPath: "C:\\tokengo.exe",
				fileExists: () => false,
				isBunBinary: true,
			}),
		).toEqual({ command: "C:\\tokengo.exe", args: ["-p"] });
	});

	it("falls back to the app name under a generic runtime", () => {
		expect(
			getSubagentInvocation(["-p"], { argv1: "/missing.js", execPath: "/usr/bin/node", fileExists: () => false }),
		).toEqual({ command: APP_NAME, args: ["-p"] });
		expect(
			getSubagentInvocation(["-p"], { argv1: undefined, execPath: "/opt/bun/bun", fileExists: () => false }),
		).toEqual({ command: APP_NAME, args: ["-p"] });
	});
});

describe("default agents", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	it("embeds scout, planner, reviewer and worker", () => {
		expect(DEFAULT_AGENTS.map((a) => a.name).sort()).toEqual(["planner", "reviewer", "scout", "worker"]);
		for (const agent of DEFAULT_AGENTS) {
			expect(agent.source).toBe("builtin");
			expect(agent.filePath).toBe(`builtin:${agent.name}`);
			expect(agent.systemPrompt.trim().length).toBeGreaterThan(0);
			expect(agent.model).toBeUndefined();
		}
	});

	it("lets a user agent override a builtin of the same name", () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-builtin-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "scout.md"),
			"---\nname: scout\ndescription: custom scout\n---\ncustom prompt\n",
		);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv(`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, agentDir);

		const { agents } = discoverAgents(root, "user");
		expect(agents.find((a) => a.name === "scout")).toMatchObject({ source: "user", description: "custom scout" });
		expect(agents.find((a) => a.name === "worker")?.source).toBe("builtin");
	});
});

describe("builtInExtensions", () => {
	it("registers token-go and subagent", () => {
		expect(builtInExtensions.map((e) => e.name)).toEqual(
			expect.arrayContaining(["llama.cpp", "codemode", "tool-search", "mcp", "token-go", "subagent"]),
		);
		const tokenGo = builtInExtensions.find((e) => e.name === "token-go");
		expect(tokenGo).toMatchObject({ builtin: true });
		expect(tokenGo).not.toHaveProperty("replaceable", true);
		expect(builtInExtensions.find((e) => e.name === "subagent")).toMatchObject({ builtin: true, replaceable: true });
	});
});
