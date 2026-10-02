import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnProcessSync } from "./child-process.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
const RELEASE_REPOSITORY = "zxcrf/tokengo-cli";
const BINARY_NAME = "tokengo";
const CHECKSUMS_ASSET_NAME = "SHA256SUMS";

export type BinaryPlatform =
	| "darwin-arm64"
	| "darwin-x64"
	| "linux-x64"
	| "linux-arm64"
	| "windows-x64"
	| "windows-arm64";

export interface ReleaseAsset {
	name: string;
	browser_download_url: string;
}

export interface BinarySelfUpdateOptions {
	/** Target version without the leading `v`. */
	version: string;
	/** Release tag as published on GitHub. Defaults to `v<version>`. */
	tag?: string;
	/** Directory containing the running executable and its sibling assets. */
	packageDir: string;
	platform?: NodeJS.Platform;
	arch?: string;
	signal?: AbortSignal;
	/** Override for tests. */
	apiBase?: string;
}

/** Map Node's platform/arch to the release asset platform suffix. */
export function getBinaryPlatform(platform: NodeJS.Platform, arch: string): BinaryPlatform {
	const os = platform === "win32" ? "windows" : platform;
	if ((os === "darwin" || os === "linux" || os === "windows") && (arch === "x64" || arch === "arm64")) {
		return `${os}-${arch}`;
	}
	throw new Error(`Unsupported platform for binary self-update: ${platform}-${arch}`);
}

export function getBinaryArchiveName(binaryPlatform: BinaryPlatform): string {
	return `${BINARY_NAME}-${binaryPlatform}.${binaryPlatform.startsWith("windows-") ? "zip" : "tar.gz"}`;
}

/** Parse `sha256sum` output into a file name to lowercase hex digest map. */
export function parseSha256Sums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
		if (match) sums.set(match[2], match[1].toLowerCase());
	}
	return sums;
}

function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function githubHeaders(version: string, accept: string): Record<string, string> {
	const token = process.env.GITHUB_TOKEN?.trim();
	return {
		"User-Agent": getPiUserAgent(version),
		accept,
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

async function download(url: string, version: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
	const response = await fetchWithRetry(
		url,
		{ headers: githubHeaders(version, "application/octet-stream"), signal },
		{ maxRetries: 2, timeoutMs: 10 * 60 * 1000 },
	);
	if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
	return new Uint8Array(await response.arrayBuffer());
}

function findAsset(assets: ReleaseAsset[], name: string, tag: string): ReleaseAsset {
	const asset = assets.find((candidate) => candidate.name === name);
	if (!asset) {
		throw new Error(`Release ${tag} does not contain the asset "${name}"`);
	}
	return asset;
}

function extractArchive(archivePath: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	// bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz; bsdtar also reads .zip.
	const result = spawnProcessSync("tar", ["-xf", archivePath, "-C", destination], { encoding: "utf-8" });
	if (result.error || result.status !== 0) {
		const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status}`;
		throw new Error(`Failed to extract ${archivePath}: ${detail}`);
	}
}

/** Names left behind by an interrupted or locked Windows swap. They never count as install content. */
const LEFTOVER_ENTRY_RE = /\.old-\d+$|^\.tokengo-old-\d+$/;

function listFiles(root: string, dir = root): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(root, full));
		else files.push(relative(root, full));
	}
	return files;
}

/**
 * Refuse to replace a directory that is not a dedicated tokengo install.
 * The live directory must carry tokengo's package.json and every top-level entry
 * in it must also exist in the new release, so unrelated files are never swapped away.
 */
export function assertDedicatedInstallDir(packageDir: string, newDir: string): void {
	let configName: unknown;
	try {
		const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as {
			piConfig?: { name?: unknown };
		};
		configName = manifest.piConfig?.name;
	} catch {
		// Reported below.
	}
	if (configName !== BINARY_NAME) {
		throw new Error(`Refusing to update ${packageDir}: it is not a dedicated ${BINARY_NAME} install directory`);
	}
	const incoming = new Set(readdirSync(newDir));
	const foreign = readdirSync(packageDir).filter((name) => !LEFTOVER_ENTRY_RE.test(name) && !incoming.has(name));
	if (foreign.length > 0) {
		throw new Error(
			`Refusing to update ${packageDir}: it contains files that are not part of a ${BINARY_NAME} release (${foreign.join(", ")})`,
		);
	}
}

export interface SwapHooks {
	/** Override for tests; defaults to `copyFileSync`. */
	copyFile?: (source: string, destination: string) => void;
}

/** Windows cannot rename a directory holding the running executable, so replace it file by file. */
function swapInstallWindows(packageDir: string, newDir: string, hooks: SwapHooks): void {
	const copyFile = hooks.copyFile ?? copyFileSync;
	const exe = join(packageDir, `${BINARY_NAME}.exe`);
	const exeAside = `${exe}.old-${process.pid}`;
	const backupRoot = join(packageDir, `.tokengo-old-${process.pid}`);
	const written: { destination: string; backup?: string }[] = [];
	let exeMoved = false;

	try {
		if (existsSync(exe)) {
			renameSync(exe, exeAside);
			exeMoved = true;
		}
		for (const file of listFiles(newDir)) {
			const destination = join(packageDir, file);
			mkdirSync(dirname(destination), { recursive: true });
			let backup: string | undefined;
			if (existsSync(destination)) {
				// Loaded DLLs cannot be overwritten but can be renamed.
				backup = join(backupRoot, file);
				mkdirSync(dirname(backup), { recursive: true });
				renameSync(destination, backup);
			}
			written.push({ destination, backup });
			copyFile(join(newDir, file), destination);
		}
	} catch (error) {
		for (const { destination, backup } of written.reverse()) {
			rmSync(destination, { force: true });
			if (backup) renameSync(backup, destination);
		}
		if (exeMoved) renameSync(exeAside, exe);
		rmSync(backupRoot, { recursive: true, force: true });
		throw error;
	}

	// Locked files stay until the next start, when cleanupWindowsSelfUpdateQuarantine removes them.
	for (const target of [backupRoot, exeAside]) {
		try {
			rmSync(target, { recursive: true, force: true });
		} catch {
			// Still in use by the running process.
		}
	}
}

/** Replace `packageDir` with `newDir`. */
export function swapInstall(packageDir: string, newDir: string, isWindows: boolean, hooks: SwapHooks = {}): void {
	assertDedicatedInstallDir(packageDir, newDir);
	if (isWindows) {
		swapInstallWindows(packageDir, newDir, hooks);
		return;
	}

	const backupDir = `${packageDir}.old-${process.pid}`;
	renameSync(packageDir, backupDir);
	try {
		renameSync(newDir, packageDir);
	} catch (error) {
		renameSync(backupDir, packageDir);
		throw error;
	}
	rmSync(backupDir, { recursive: true, force: true });
}

/**
 * Update a compiled tokengo binary in place from the matching GitHub release.
 * Downloads the platform archive, verifies it against SHA256SUMS, then swaps
 * the install directory. Throws with a descriptive message on any failure and
 * leaves the existing installation untouched until the swap itself.
 */
export async function runBinarySelfUpdate(options: BinarySelfUpdateOptions): Promise<void> {
	const platform = options.platform ?? process.platform;
	const binaryPlatform = getBinaryPlatform(platform, options.arch ?? process.arch);
	const isWindows = binaryPlatform.startsWith("windows-");
	const apiBase = options.apiBase ?? DEFAULT_GITHUB_API_BASE;
	const tag = options.tag ?? `v${options.version}`;

	const releaseResponse = await fetchWithRetry(
		`${apiBase}/repos/${RELEASE_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
		{
			headers: githubHeaders(options.version, "application/vnd.github+json"),
			signal: options.signal,
		},
		{ maxRetries: 2, timeoutMs: 30_000 },
	);
	if (!releaseResponse.ok) {
		throw new Error(`Could not fetch release ${tag} (${releaseResponse.status})`);
	}
	const release = (await releaseResponse.json()) as { assets?: ReleaseAsset[] };
	const assets = Array.isArray(release.assets) ? release.assets : [];

	const archiveName = getBinaryArchiveName(binaryPlatform);
	const archiveAsset = findAsset(assets, archiveName, tag);
	const checksumsAsset = findAsset(assets, CHECKSUMS_ASSET_NAME, tag);

	const packageDir = realpathSync(options.packageDir);
	const stagingDir = join(dirname(packageDir), `.${BINARY_NAME}-update-${process.pid}`);
	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });
	try {
		const archive = await download(archiveAsset.browser_download_url, options.version, options.signal);
		const checksums = parseSha256Sums(
			new TextDecoder().decode(await download(checksumsAsset.browser_download_url, options.version, options.signal)),
		);
		const expected = checksums.get(archiveName);
		if (!expected) {
			throw new Error(`${CHECKSUMS_ASSET_NAME} of ${tag} has no entry for ${archiveName}`);
		}
		const actual = sha256Hex(archive);
		if (actual !== expected) {
			throw new Error(`Checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`);
		}

		const archivePath = join(stagingDir, archiveName);
		writeFileSync(archivePath, archive);
		const extractDir = join(stagingDir, "extracted");
		extractArchive(archivePath, extractDir);

		// Unix archives wrap everything in a `tokengo/` directory; Windows zips are flat.
		const newDir = isWindows ? extractDir : join(extractDir, BINARY_NAME);
		const executable = join(newDir, isWindows ? `${BINARY_NAME}.exe` : BINARY_NAME);
		if (!existsSync(executable) || readFileSync(executable).length === 0) {
			throw new Error(`Archive ${archiveName} does not contain the ${BINARY_NAME} executable`);
		}

		swapInstall(packageDir, newDir, isWindows);
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
	}
}
