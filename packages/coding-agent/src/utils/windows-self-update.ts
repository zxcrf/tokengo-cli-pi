import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, toNamespacedPath } from "node:path";
import { getCwdRelativePath } from "./paths.ts";

const QUARANTINE_DIR_NAME = ".pi-native-quarantine";

function normalizePath(path: string): string {
	return toNamespacedPath(resolve(path));
}

function getQuarantineRoot(packageDir: string): string | undefined {
	let current = resolve(packageDir);
	while (true) {
		if (basename(current).toLowerCase() === "node_modules") {
			return join(current, QUARANTINE_DIR_NAME);
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

function getLoadedSharedObjectsInPackageDir(packageDir: string): string[] {
	const sharedObjects = (process.report.getReport() as { sharedObjects?: unknown }).sharedObjects;
	if (!Array.isArray(sharedObjects)) {
		return [];
	}

	const root = normalizePath(packageDir).toLowerCase();
	const seen = new Set<string>();
	const loadedFiles: string[] = [];
	for (const value of sharedObjects) {
		if (typeof value !== "string") {
			continue;
		}
		const filePath = normalizePath(value);
		const comparisonPath = filePath.toLowerCase();
		if (getCwdRelativePath(comparisonPath, root) === undefined || seen.has(comparisonPath)) {
			continue;
		}
		seen.add(comparisonPath);
		loadedFiles.push(filePath);
	}
	return loadedFiles;
}

/** Remove files left behind by a binary self-update that could not delete them while they were in use. */
function cleanupBinarySelfUpdateLeftovers(packageDir: string, execPath: string): void {
	const execName = basename(execPath);
	const execDir = dirname(execPath);
	const targets: string[] = [];
	try {
		for (const name of readdirSync(execDir)) {
			if (name.startsWith(`${execName}.old-`)) targets.push(join(execDir, name));
		}
		for (const name of readdirSync(packageDir)) {
			if (/^\.tokengo-old-\d+$/.test(name)) targets.push(join(packageDir, name));
		}
	} catch {
		return;
	}
	for (const target of targets) {
		try {
			rmSync(target, { recursive: true, force: true });
		} catch {
			// EBUSY while a previous process is still exiting; the next start retries.
		}
	}
}

export function cleanupWindowsSelfUpdateQuarantine(packageDir: string, execPath: string = process.execPath): void {
	cleanupBinarySelfUpdateLeftovers(packageDir, execPath);
	const quarantineRoot = getQuarantineRoot(packageDir);
	if (!quarantineRoot) {
		return;
	}
	try {
		rmSync(quarantineRoot, { recursive: true, force: true });
	} catch {
		// A previous pi process may still be exiting and holding a native addon.
	}
}

export function quarantineWindowsNativeDependencies(packageDir: string): void {
	const resolvedPackageDir = normalizePath(packageDir);
	const quarantineRoot = getQuarantineRoot(resolvedPackageDir);
	if (!quarantineRoot) {
		return;
	}

	const loadedFiles = getLoadedSharedObjectsInPackageDir(resolvedPackageDir);
	if (loadedFiles.length === 0) {
		return;
	}

	const quarantineRunDir = join(quarantineRoot, `${Date.now()}-${process.pid}-${randomUUID()}`);
	for (const loadedFile of loadedFiles) {
		if (!existsSync(loadedFile)) {
			continue;
		}
		const quarantinePath = join(quarantineRunDir, relative(resolvedPackageDir, loadedFile));
		mkdirSync(dirname(quarantinePath), { recursive: true });
		renameSync(loadedFile, quarantinePath);
		copyFileSync(quarantinePath, loadedFile);
	}
}
