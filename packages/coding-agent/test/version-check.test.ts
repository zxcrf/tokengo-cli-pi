import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3", tag: "v1.2.3" });
	});

	it("uses the GitHub releases api with a tokengo user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/zxcrf/tokengo-cli/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^tokengo-cli\/1\.2\.3 /),
					accept: "application/vnd.github+json",
				}),
			}),
		);
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4", tag: "v1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("strips the leading v from prerelease tags", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ tag_name: "v1.0.0-tokengo.2" })),
		);

		await expect(getLatestPiRelease("1.0.0-tokengo.1")).resolves.toEqual({
			version: "1.0.0-tokengo.2",
			tag: "v1.0.0-tokengo.2",
		});
	});

	it("returns undefined when the release has no tag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);

		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
	});

	it("retries once without the token when GitHub rejects it with 401", async () => {
		vi.stubEnv("GITHUB_TOKEN", "bad");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
			.mockResolvedValueOnce(Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ version: "1.2.4", tag: "v1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondHeaders = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<
			string,
			string
		>;
		expect(secondHeaders.authorization).toBeUndefined();
		vi.unstubAllEnvs();
	});

	it("explains rate limits on 403 and a missing release on 404", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("limited", { status: 403 })),
		);
		await expect(getLatestPiRelease("1.2.3")).rejects.toThrow(/rate limit.*GITHUB_TOKEN/);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("missing", { status: 404 })),
		);
		await expect(getLatestPiRelease("1.2.3")).rejects.toThrow(/No tokengo release found/);
	});

	it("sends GITHUB_TOKEN as a bearer token when set", async () => {
		vi.stubEnv("GITHUB_TOKEN", "ghp_test");
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await getLatestPiRelease("1.2.3");
		expect(fetchMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer ghp_test" }) }),
		);
		vi.unstubAllEnvs();
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
