import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getBinaryArchiveName,
	getBinaryPlatform,
	parseSha256Sums,
	runBinarySelfUpdate,
	swapInstall,
} from "../src/utils/binary-self-update.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "../src/utils/windows-self-update.ts";
import { allowNetwork } from "./test-network-env.ts";

const ARCHIVE_NAME = "tokengo-linux-x64.tar.gz";
const TOKENGO_MANIFEST = JSON.stringify({ piConfig: { name: "tokengo" } });

describe("binary self-update pure helpers", () => {
	it("maps node platform and arch to release platforms", () => {
		expect(getBinaryPlatform("darwin", "arm64")).toBe("darwin-arm64");
		expect(getBinaryPlatform("darwin", "x64")).toBe("darwin-x64");
		expect(getBinaryPlatform("linux", "x64")).toBe("linux-x64");
		expect(getBinaryPlatform("linux", "arm64")).toBe("linux-arm64");
		expect(getBinaryPlatform("win32", "x64")).toBe("windows-x64");
		expect(getBinaryPlatform("win32", "arm64")).toBe("windows-arm64");
		expect(() => getBinaryPlatform("freebsd", "x64")).toThrow(/Unsupported platform/);
		expect(() => getBinaryPlatform("linux", "ia32")).toThrow(/Unsupported platform/);
	});

	it("names archives per platform", () => {
		expect(getBinaryArchiveName("darwin-arm64")).toBe("tokengo-darwin-arm64.tar.gz");
		expect(getBinaryArchiveName("windows-x64")).toBe("tokengo-windows-x64.zip");
	});

	it("parses sha256sum output", () => {
		const digest = "a".repeat(64);
		const other = "B".repeat(64);
		const sums = parseSha256Sums(
			`${digest}  tokengo-linux-x64.tar.gz\n${other} *tokengo-windows-x64.zip\r\nnot a line\n`,
		);
		expect(sums.get("tokengo-linux-x64.tar.gz")).toBe(digest);
		expect(sums.get("tokengo-windows-x64.zip")).toBe("b".repeat(64));
		expect(sums.size).toBe(2);
	});
});

describe("runBinarySelfUpdate", () => {
	let root: string;
	let packageDir: string;
	let archive: Buffer;

	function sha(data: Uint8Array): string {
		return createHash("sha256").update(data).digest("hex");
	}

	function mockGithub(options: { assets?: string[]; sums?: string; archiveBody?: Buffer }): void {
		const assets = options.assets ?? [ARCHIVE_NAME, "SHA256SUMS"];
		const sums = options.sums ?? `${sha(archive)}  ${ARCHIVE_NAME}\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url === "https://api.example.test/repos/zxcrf/tokengo-cli/releases/tags/v2.0.0") {
					return Response.json({
						assets: assets.map((name) => ({
							name,
							browser_download_url: `https://download.example.test/${name}`,
						})),
					});
				}
				if (url === `https://download.example.test/${ARCHIVE_NAME}`) {
					return new Response(new Uint8Array(options.archiveBody ?? archive));
				}
				if (url === "https://download.example.test/SHA256SUMS") return new Response(sums);
				return new Response("not found", { status: 404 });
			}),
		);
	}

	function update(): Promise<void> {
		return runBinarySelfUpdate({
			version: "2.0.0",
			packageDir,
			platform: "linux",
			arch: "x64",
			apiBase: "https://api.example.test",
		});
	}

	beforeEach(() => {
		allowNetwork();
		root = mkdtempSync(join(tmpdir(), "tokengo-self-update-"));
		packageDir = join(root, "tokengo");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "tokengo"), "old binary");
		writeFileSync(join(packageDir, "package.json"), TOKENGO_MANIFEST);

		const build = join(root, "build");
		mkdirSync(join(build, "tokengo"), { recursive: true });
		writeFileSync(join(build, "tokengo", "tokengo"), "new binary");
		writeFileSync(join(build, "tokengo", "package.json"), TOKENGO_MANIFEST);
		const archivePath = join(root, ARCHIVE_NAME);
		const result = spawnSync("tar", ["-czf", archivePath, "-C", build, "tokengo"]);
		expect(result.status).toBe(0);
		archive = readFileSync(archivePath);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(root, { recursive: true, force: true });
	});

	it("verifies the checksum, swaps the install and cleans up", async () => {
		mockGithub({});

		await update();

		expect(readFileSync(join(packageDir, "tokengo"), "utf-8")).toBe("new binary");
		expect(existsSync(join(packageDir, "package.json"))).toBe(true);
		expect(existsSync(`${packageDir}.old-${process.pid}`)).toBe(false);
		expect(existsSync(join(root, `.tokengo-update-${process.pid}`))).toBe(false);
	});

	it("refuses to swap a directory that holds foreign files and leaves it untouched", async () => {
		mockGithub({});
		writeFileSync(join(packageDir, "notes.txt"), "mine");

		await expect(update()).rejects.toThrow(/not part of a tokengo release \(notes\.txt\)/);

		expect(readFileSync(join(packageDir, "tokengo"), "utf-8")).toBe("old binary");
		expect(readFileSync(join(packageDir, "notes.txt"), "utf-8")).toBe("mine");
		expect(existsSync(`${packageDir}.old-${process.pid}`)).toBe(false);
	});

	it("refuses a directory without the tokengo manifest", async () => {
		mockGithub({});
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ piConfig: { name: "pi" } }));

		await expect(update()).rejects.toThrow(/not a dedicated tokengo install directory/);
		expect(readFileSync(join(packageDir, "tokengo"), "utf-8")).toBe("old binary");
	});

	it("rejects a checksum mismatch and keeps the current install", async () => {
		mockGithub({ sums: `${"0".repeat(64)}  ${ARCHIVE_NAME}\n` });

		await expect(update()).rejects.toThrow(/Checksum mismatch/);

		expect(readFileSync(join(packageDir, "tokengo"), "utf-8")).toBe("old binary");
		expect(existsSync(join(root, `.tokengo-update-${process.pid}`))).toBe(false);
	});

	it("rejects when SHA256SUMS has no entry for the archive", async () => {
		mockGithub({ sums: `${"0".repeat(64)}  other.tar.gz\n` });

		await expect(update()).rejects.toThrow(/no entry for tokengo-linux-x64\.tar\.gz/);
	});

	it("reports a missing release asset", async () => {
		mockGithub({ assets: ["SHA256SUMS"] });

		await expect(update()).rejects.toThrow(/does not contain the asset "tokengo-linux-x64\.tar\.gz"/);
		expect(readFileSync(join(packageDir, "tokengo"), "utf-8")).toBe("old binary");
	});

	it("reports a missing checksum asset", async () => {
		mockGithub({ assets: [ARCHIVE_NAME] });

		await expect(update()).rejects.toThrow(/does not contain the asset "SHA256SUMS"/);
	});

	it("reports an unknown release", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 404 })),
		);

		await expect(update()).rejects.toThrow(/Could not fetch release v2\.0\.0 \(404\)/);
	});
});

describe("windows swap", () => {
	let root: string;
	let live: string;
	let incoming: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tokengo-win-swap-"));
		live = join(root, "live");
		incoming = join(root, "incoming");
		mkdirSync(join(live, "native"), { recursive: true });
		mkdirSync(join(incoming, "native"), { recursive: true });
		writeFileSync(join(live, "package.json"), TOKENGO_MANIFEST);
		writeFileSync(join(live, "tokengo.exe"), "old exe");
		writeFileSync(join(live, "native", "a.node"), "old a");
		writeFileSync(join(incoming, "package.json"), TOKENGO_MANIFEST);
		writeFileSync(join(incoming, "tokengo.exe"), "new exe");
		writeFileSync(join(incoming, "native", "a.node"), "new a");
		writeFileSync(join(incoming, "extra.txt"), "new extra");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("replaces files and removes its backups", () => {
		swapInstall(live, incoming, true);

		expect(readFileSync(join(live, "tokengo.exe"), "utf-8")).toBe("new exe");
		expect(readFileSync(join(live, "native", "a.node"), "utf-8")).toBe("new a");
		expect(readFileSync(join(live, "extra.txt"), "utf-8")).toBe("new extra");
		expect(readdirSync(live).filter((name) => name.includes(".old-") || name.startsWith(".tokengo-old-"))).toEqual(
			[],
		);
	});

	it("rolls back every written file when a copy fails", () => {
		let copies = 0;
		const copyFile = (source: string, destination: string) => {
			copies++;
			if (copies === 3) throw new Error("disk full");
			writeFileSync(destination, readFileSync(source));
		};

		expect(() => swapInstall(live, incoming, true, { copyFile })).toThrow("disk full");

		expect(readFileSync(join(live, "tokengo.exe"), "utf-8")).toBe("old exe");
		expect(readFileSync(join(live, "native", "a.node"), "utf-8")).toBe("old a");
		expect(readFileSync(join(live, "package.json"), "utf-8")).toBe(TOKENGO_MANIFEST);
		expect(existsSync(join(live, "extra.txt"))).toBe(false);
		expect(readdirSync(live).filter((name) => name.includes(".old-") || name.startsWith(".tokengo-old-"))).toEqual(
			[],
		);
	});

	it("cleans leftovers of a previous update at startup", () => {
		const exe = join(live, "tokengo.exe");
		writeFileSync(`${exe}.old-123`, "stale");
		mkdirSync(join(live, ".tokengo-old-123"));
		writeFileSync(join(live, ".tokengo-old-123", "x"), "stale");

		cleanupWindowsSelfUpdateQuarantine(live, exe);

		expect(existsSync(`${exe}.old-123`)).toBe(false);
		expect(existsSync(join(live, ".tokengo-old-123"))).toBe(false);
		expect(existsSync(exe)).toBe(true);
	});
});
