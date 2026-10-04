/**
 * Small catalog reader used by the local TokenGo smoke test and by manual
 * checks. Network is preferred; a previously written JSON snapshot is used
 * when the relay is unavailable. The on-disk format is intentionally plain so
 * it can be inspected or copied between test runs.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TokenGoCatalogSnapshot {
	models: readonly string[];
	fetchedAt: string;
}

export interface TokenGoCatalogResult {
	models: readonly string[];
	source: "network" | "cache";
}

export interface ReadTokenGoCatalogOptions {
	baseUrl: string;
	pat: string;
	group?: string;
	cacheFile: string;
	fetch?: typeof globalThis.fetch;
}

function isSnapshot(value: unknown): value is TokenGoCatalogSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Array.isArray(record.models) &&
		record.models.every(model => typeof model === "string") &&
		typeof record.fetchedAt === "string"
	);
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

async function readSnapshot(path: string): Promise<TokenGoCatalogSnapshot | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isSnapshot(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function readTokenGoCatalog(options: ReadTokenGoCatalogOptions): Promise<TokenGoCatalogResult> {
	const run = options.fetch ?? globalThis.fetch;
	const group = options.group ?? "tokengo";
	try {
		const response = await run(
			`${normalizeBaseUrl(options.baseUrl)}/api/user/models?group=${encodeURIComponent(group)}`,
			{ headers: { Authorization: `Bearer ${options.pat}`, Accept: "application/json" } },
		);
		const body: unknown = await response.json();
		if (!response.ok || typeof body !== "object" || body === null || Array.isArray(body))
			throw new Error("catalog request failed");
		const data = (body as Record<string, unknown>).data;
		if (!Array.isArray(data) || !data.every(model => typeof model === "string"))
			throw new Error("catalog response malformed");
		const snapshot: TokenGoCatalogSnapshot = { models: data, fetchedAt: new Date().toISOString() };
		await mkdir(dirname(options.cacheFile), { recursive: true });
		await writeFile(options.cacheFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
		return { models: snapshot.models, source: "network" };
	} catch (error) {
		const snapshot = await readSnapshot(options.cacheFile);
		if (snapshot) return { models: snapshot.models, source: "cache" };
		throw error;
	}
}
