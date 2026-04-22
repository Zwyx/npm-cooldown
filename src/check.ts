import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import semver from "semver";

import type {
	Config,
	PackageInfo,
	PackageLock,
	PackageLockV1Dep,
	PinEntry,
	RegistryPackument,
	TooNewEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONCURRENCY = 10;

function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "") // block comments
		.replace(/\/\/.*$/gm, "") // line comments
		.replace(/,(\s*[}\]])/g, "$1"); // trailing commas left behind by removed lines
}

function loadConfig(): Config {
	const locations = [
		path.join(os.homedir(), ".npm-cooldown_config"),
		path.resolve(".npm-cooldown_config"),
	];
	const config: Config = {};
	for (const loc of locations) {
		let raw: string;
		try {
			raw = fs.readFileSync(loc, "utf8");
		} catch {
			continue; // file doesn't exist — skip
		}
		try {
			Object.assign(config, JSON.parse(stripComments(raw)));
		} catch (err) {
			process.stderr.write(
				`Error: invalid config file ${loc}: ${(err as Error).message}\n`,
			);
			process.exit(1);
		}
	}
	return config;
}

export const config = loadConfig();
export const COOLDOWN_DAYS = config.minimumReleaseAge ?? 7;
export const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// .npmrc
// ---------------------------------------------------------------------------

interface NpmrcState {
	defaultRegistry: string;
	scopeRegistries: Map<string, string>; // "@scope" → registry URL
	authTokens: Map<string, string>; // "//host/path/" → Bearer token
	basicAuth: Map<string, string>; // "//host/path/" → base64 user:pass
}

function expandEnvVars(val: string): string {
	return val.replace(
		/\$\{([^}]+)\}/g,
		(_, name: string) => process.env[name] ?? "",
	);
}

function parseNpmrc(content: string, state: NpmrcState): void {
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) {
			continue;
		}
		const eq = line.indexOf("=");
		if (eq === -1) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		const val = expandEnvVars(line.slice(eq + 1).trim());
		if (key === "registry") {
			state.defaultRegistry = val.endsWith("/") ? val : `${val}/`;
		} else if (key.endsWith(":registry")) {
			const scope = key.slice(0, -":registry".length);
			state.scopeRegistries.set(scope, val.endsWith("/") ? val : `${val}/`);
		} else if (key.endsWith(":_authToken")) {
			const regKey = key.slice(0, -":_authToken".length);
			state.authTokens.set(regKey, val);
		} else if (key.endsWith(":_auth")) {
			const regKey = key.slice(0, -":_auth".length);
			state.basicAuth.set(regKey, val);
		}
	}
}

function loadNpmrc(): NpmrcState {
	const state: NpmrcState = {
		defaultRegistry: "https://registry.npmjs.org/",
		scopeRegistries: new Map(),
		authTokens: new Map(),
		basicAuth: new Map(),
	};
	for (const loc of [
		path.join(os.homedir(), ".npmrc"),
		path.resolve(".npmrc"),
	]) {
		try {
			parseNpmrc(fs.readFileSync(loc, "utf8"), state);
		} catch {
			// ignore — file may not exist
		}
	}
	return state;
}

const npmrc = loadNpmrc();

function registryForPackage(name: string): string {
	if (name.startsWith("@")) {
		const scope = name.slice(0, name.indexOf("/"));
		const reg = npmrc.scopeRegistries.get(scope);
		if (reg !== undefined) {
			return reg;
		}
	}
	return npmrc.defaultRegistry;
}

function authHeader(registryBaseUrl: string): string | undefined {
	// Strip protocol to match against "//host/path/" keys from .npmrc
	const noProto = registryBaseUrl.replace(/^https?:/, "");
	for (const [key, token] of npmrc.authTokens) {
		if (noProto.startsWith(key)) {
			return `Bearer ${token}`;
		}
	}
	for (const [key, auth] of npmrc.basicAuth) {
		if (noProto.startsWith(key)) {
			return `Basic ${auth}`;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function registryUrl(name: string): string {
	return `${registryForPackage(name)}${name.replaceAll("/", "%2F")}`;
}

const packumentCache = new Map<string, Promise<RegistryPackument>>();

export function clearPackumentCache(): void {
	packumentCache.clear();
}

async function fetchPackument(name: string): Promise<RegistryPackument> {
	let p = packumentCache.get(name);
	if (p === undefined) {
		const url = registryUrl(name);
		const auth = authHeader(registryForPackage(name));
		const headers: Record<string, string> =
			auth !== undefined ? { Authorization: auth } : {};
		p = fetch(url, { headers }).then((res) => {
			if (!res.ok) {
				throw new Error(`HTTP ${String(res.status)} fetching ${name}`);
			}
			return res.json() as Promise<RegistryPackument>;
		});
		packumentCache.set(name, p);
	}
	return p;
}

async function getPublishTime(name: string, version: string): Promise<Date> {
	let data = await fetchPackument(name);
	if (!data.time[version]) {
		// Version not in cached packument — it was published after our initial fetch.
		// Clear the cache and re-fetch to get up-to-date data.
		packumentCache.delete(name);
		data = await fetchPackument(name);
	}
	const time = data.time[version];
	if (!time) {
		throw new Error(`No publish time found for ${name}@${version}`);
	}
	return new Date(time);
}

function resolveVersionWithNpm(name: string, versionHint: string): string {
	const result = spawnSync(
		"npm",
		["view", `${name}@${versionHint}`, "version", "--json"],
		{ encoding: "utf8" },
	);
	if (result.status !== 0 || !result.stdout.trim()) {
		throw new Error(`Cannot resolve ${name}@${versionHint}`);
	}
	const parsed = JSON.parse(result.stdout.trim()) as string | string[];
	if (Array.isArray(parsed)) {
		const last = parsed.at(-1);
		if (last === undefined) {
			throw new Error(
				`npm view returned no versions for ${name}@${versionHint}`,
			);
		}
		return last;
	}
	return parsed;
}

async function resolvePackage(
	name: string,
	versionHint = "latest",
): Promise<PackageInfo> {
	const version = resolveVersionWithNpm(name, versionHint);
	const data = await fetchPackument(name);

	const versionData = data.versions[version];
	if (versionData === undefined) {
		throw new Error(`Cannot resolve ${name}@${versionHint}`);
	}

	return {
		name,
		version,
		publishTime: new Date(data.time[version]),
		deps: {
			...versionData.dependencies,
			...versionData.optionalDependencies,
		},
	};
}

export async function resolvePackageAtDate(
	name: string,
	beforeDate: Date,
	majorHint?: number,
	rangeConstraint?: string,
): Promise<
	PackageInfo & {
		needsPin: boolean | "unavailable";
		latestVersion: string;
		latestPublishTime: Date;
		latestDeps: Record<string, string>;
	}
> {
	const data = await fetchPackument(name);

	// Exact prerelease constraint (e.g. "1.0.0-rc.15"): there is no stable
	// alternative to substitute, so just check whether that specific version
	// is old enough and pass or block accordingly.
	if (rangeConstraint !== undefined) {
		const exactPre = semver.parse(rangeConstraint) ?? undefined;
		if (exactPre !== undefined && exactPre.prerelease.length > 0) {
			const version = rangeConstraint;
			const publishTime = new Date(data.time[version]);
			const deps = {
				...data.versions[version]?.dependencies,
				...data.versions[version]?.optionalDependencies,
			};
			return {
				name,
				version,
				latestVersion: version,
				publishTime,
				latestPublishTime: publishTime,
				deps,
				latestDeps: deps,
				needsPin:
					Date.now() - publishTime.getTime() < COOLDOWN_MS ?
						"unavailable"
					:	false,
			};
		}
	}

	const stable = ([v]: [string, string]) => {
		const sv = semver.parse(v) ?? undefined;
		return (
			sv !== undefined &&
			data.versions[v] !== undefined &&
			sv.prerelease.length === 0 &&
			(majorHint === undefined || sv.major === majorHint) &&
			(rangeConstraint === undefined || semver.satisfies(v, rangeConstraint))
		);
	};

	const allStable = Object.entries(data.time)
		.filter(stable)
		.sort(([a], [b]) => compareSemver(b, a));

	if (allStable.length === 0) {
		// No stable release exists (e.g. the package only publishes prerelease versions).
		// Check whether the latest version is old enough; only block if it isn't.
		const latestVersion = data["dist-tags"].latest;
		const latestTime = data.time[latestVersion];
		const publishTime = new Date(latestTime);
		const deps = {
			...data.versions[latestVersion]?.dependencies,
			...data.versions[latestVersion]?.optionalDependencies,
		};
		return {
			name,
			version: latestVersion,
			latestVersion,
			publishTime,
			latestPublishTime: publishTime,
			deps,
			latestDeps: deps,
			needsPin:
				Date.now() - publishTime.getTime() < COOLDOWN_MS ?
					"unavailable"
				:	false,
		};
	}

	const [latestVersion, latestTime] = allStable[0];
	if (Date.now() - new Date(latestTime).getTime() >= COOLDOWN_MS) {
		// Current latest in this major is already old enough — no pin needed
		const deps = {
			...data.versions[latestVersion]?.dependencies,
			...data.versions[latestVersion]?.optionalDependencies,
		};
		return {
			name,
			version: latestVersion,
			latestVersion,
			publishTime: new Date(latestTime),
			latestPublishTime: new Date(latestTime),
			deps,
			latestDeps: deps,
			needsPin: false,
		};
	}

	const candidates = allStable.filter(([, t]) => new Date(t) <= beforeDate);
	if (candidates.length === 0) {
		// Brand-new package: no version existed before the snapshot date.
		// Return the latest version so the caller can report it as blocked.
		return {
			name,
			version: latestVersion,
			latestVersion,
			publishTime: new Date(latestTime),
			latestPublishTime: new Date(latestTime),
			deps: {},
			latestDeps: {},
			needsPin: "unavailable",
		};
	}

	const [version, time] = candidates[0];
	const latestDeps = {
		...data.versions[latestVersion]?.dependencies,
		...data.versions[latestVersion]?.optionalDependencies,
	};
	return {
		name,
		version,
		latestVersion,
		publishTime: new Date(time),
		latestPublishTime: new Date(latestTime),
		deps: {
			...data.versions[version]?.dependencies,
			...data.versions[version]?.optionalDependencies,
		},
		latestDeps,
		needsPin: true,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if `name` matches an entry in `exceptions`.
 *  A bare scope like `@types` matches any package under that scope (`@types/node`, etc.).
 *  Anything else is matched exactly. */
export function isException(name: string, exceptions: string[]): boolean {
	return exceptions.some((e) =>
		e.startsWith("@") && !e.includes("/") ?
			name.startsWith(e + "/")
		:	name === e,
	);
}

export function compareSemver(a: string, b: string): number {
	return semver.compare(a, b);
}

function minVersionFromRange(range: string): semver.SemVer | undefined {
	// Multi-range forms that can span multiple majors — extracting only the lower
	// bound (e.g. "6" from "^6.0.0 || ^7.0.0 || ^8.0.0") would give a wrong
	// majorHint to resolvePackageAtDate and a wrong visitKey, causing us to ignore
	// higher majors that legitimately satisfy the range. trackCompatGroup handles
	// OR ranges by splitting on "||" before calling this function.
	if (range.includes("||") || range.includes(" - ")) {
		return undefined;
	}
	if (/^[~^]/.test(range)) {
		return semver.coerce(range.slice(1)) ?? undefined;
	}
	const coerced = semver.coerce(range) ?? undefined;
	if (
		coerced !== undefined &&
		!range.startsWith(">") &&
		!range.startsWith("<")
	) {
		return coerced;
	}
	return undefined;
}

function majorFromRange(range: string): number | undefined {
	return minVersionFromRange(range)?.major;
}

/** Within major 0, the minor version is the breaking boundary (^0.3.0 ≠ ^0.4.0).
 *  Returns a string key that captures the true incompatibility boundary:
 *  "1", "2", … for major ≥ 1, and "0.3", "0.4", … for major 0. */
function compatGroupFromVersion(version: string): string {
	const sv = semver.parse(version);
	if (!sv) {
		return "0";
	}
	return sv.major > 0 ? String(sv.major) : `${sv.major}.${sv.minor}`;
}

export function parsePackageSpec(spec: string): {
	name: string;
	versionHint: string;
} {
	const match = spec.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/);
	if (!match) {
		throw new Error(`Invalid package spec: ${spec}`);
	}
	return {
		name: match[1],
		versionHint: (match[2] as string | undefined) ?? "latest",
	};
}

// ---------------------------------------------------------------------------
// Cooldown checks
// ---------------------------------------------------------------------------

export function extractPackagesFromLock(
	lock: PackageLock,
): Array<{ name: string; version: string }> {
	const seen = new Set<string>();
	const packages: Array<{ name: string; version: string }> = [];

	function add(name: string, version: string) {
		const key = `${name}@${version}`;
		if (!seen.has(key)) {
			seen.add(key);
			packages.push({ name, version });
		}
	}

	if (lock.packages) {
		// lockfileVersion 2/3: keys are like "node_modules/react" or "node_modules/a/node_modules/b"
		for (const [key, pkg] of Object.entries(lock.packages)) {
			if (!key || pkg.link || pkg.bundled || pkg.version === undefined) {
				continue;
			}
			// pkg.name is set when the entry is a package alias (npm:real-pkg@range) —
			// use it so we look up the real package name in the registry, not the alias.
			const name =
				pkg.name ??
				key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
			add(name, pkg.version);
		}
	} else if (lock.dependencies) {
		// lockfileVersion 1: nested dependencies object
		function collect(deps: Record<string, PackageLockV1Dep>) {
			for (const [name, dep] of Object.entries(deps)) {
				add(name, dep.version);
				if (dep.dependencies) {
					collect(dep.dependencies);
				}
			}
		}
		collect(lock.dependencies);
	}

	return packages;
}

export async function checkPackageLock(
	lock: PackageLock,
): Promise<TooNewEntry[]> {
	const packages = extractPackagesFromLock(lock);
	const exceptions = config.minimumReleaseAgeExcludes ?? [];
	const tooNew: TooNewEntry[] = [];

	for (let i = 0; i < packages.length; i += CONCURRENCY) {
		const batch = packages.slice(i, i + CONCURRENCY);
		process.stderr.write(
			batch.map((p) => `  checking ${p.name}@${p.version}...`).join("\n") +
				"\n",
		);

		const results = await Promise.allSettled(
			batch.map(({ name, version }) => getPublishTime(name, version)),
		);

		for (let j = 0; j < results.length; j++) {
			const result = results[j];
			if (result.status === "rejected") {
				const reason: unknown = result.reason;
				throw reason instanceof Error ? reason : new Error(String(reason));
			}
			const { name, version } = batch[j];
			const ageMs = Date.now() - result.value.getTime();
			if (ageMs < COOLDOWN_MS && !isException(name, exceptions)) {
				tooNew.push({ name, version, daysOld: ageMs / 86400000 });
			}
		}
	}

	return tooNew;
}

export async function checkAndCollect(
	rootSpecs: Array<{ name: string; versionHint: string }>,
	lockedVersions?: Map<string, string[]>,
) {
	const tooNew: TooNewEntry[] = [];
	// pins tracks transitive deps that need pinning, grouped by dep name.
	// Multiple entries for the same name mean different parents require different
	// majors, which triggers version-qualified flat overrides ("dep@1.x": "1.4.0").
	const pins = new Map<string, PinEntry[]>();
	// visited is keyed by "name@major.minor.patch" (or "name" when the range has no
	// minimum version) so the same package at different minimum versions is resolved
	// independently, preventing a too-low pin from silently satisfying a stricter range.
	const visited = new Set<string>();
	const visitKey = (name: string, range: string) => {
		const sv = minVersionFromRange(range);
		return sv !== undefined ?
				`${name}@${sv.major}.${sv.minor}.${sv.patch}`
			:	name;
	};
	// seenCompatGroups records every distinct compat group each dep was *required at*,
	// so we know when a dep appears at conflicting ranges across the tree — even if only
	// one of those ranges needed pinning. OR ranges contribute one group per part so
	// `^3.0.0 || ^4.0.0` adds both "3" and "4". For major ≥ 1 the group is the major
	// number; for major 0 it is "0.minor" because ^0.3.x and ^0.4.x are incompatible.
	const seenCompatGroups = new Map<string, Set<string>>();
	const trackCompatGroup = (name: string, range: string) => {
		let groups = seenCompatGroups.get(name);
		if (groups === undefined) {
			groups = new Set();
			seenCompatGroups.set(name, groups);
		}
		for (const part of range.split("||").map((s) => s.trim())) {
			const sv = minVersionFromRange(part);
			if (sv !== undefined) {
				groups.add(sv.major > 0 ? String(sv.major) : `${sv.major}.${sv.minor}`);
			}
		}
	};
	const snapshotDate = new Date(Date.now() - COOLDOWN_MS);
	const exceptions = config.minimumReleaseAgeExcludes ?? [];

	process.stderr.write("Resolving root packages...\n");
	const rootResults = await Promise.allSettled(
		rootSpecs.map(({ name, versionHint }) => resolvePackage(name, versionHint)),
	);

	const roots: PackageInfo[] = [];
	const rootDowngraded = new Map<string, string>(); // roots pinned to a historical version
	for (const result of rootResults) {
		if (result.status === "rejected") {
			const reason: unknown = result.reason;
			throw reason instanceof Error ? reason : new Error(String(reason));
		}
		const pkg = result.value;
		visited.add(pkg.name); // roots: visited by plain name (no major)

		const ageMs = Date.now() - pkg.publishTime.getTime();
		if (ageMs < COOLDOWN_MS && !isException(pkg.name, exceptions)) {
			// Too new — try to fall back to the latest old-enough version.
			const historical = await resolvePackageAtDate(
				pkg.name,
				snapshotDate,
				semver.major(pkg.version),
			);
			if (historical.needsPin === "unavailable") {
				// No version existed before the snapshot — must block.
				tooNew.push({
					name: pkg.name,
					version: pkg.version,
					daysOld: ageMs / 86400000,
				});
			} else {
				process.stderr.write(
					`  ${pkg.name}@${pkg.version} is only ${(ageMs / 86400000).toFixed(1)}d old — using ${historical.version} instead\n`,
				);
				roots.push({
					name: pkg.name,
					version: historical.version,
					publishTime: historical.publishTime,
					deps: historical.deps,
				});
				rootDowngraded.set(pkg.name, historical.version);
			}
		} else {
			roots.push(pkg);
		}
	}

	const rootPinned = new Map<string, string>(
		roots.map((r) => [r.name, r.version]),
	);

	if (tooNew.length > 0) {
		return {
			tooNew,
			pins,
			conflictingDeps: new Set<string>(),
			pinned: new Map(rootPinned),
			rootPinned,
			rootDowngraded,
		};
	}
	for (const root of roots) {
		const queue: Array<{ name: string; range: string; parentChain: string[] }> =
			Object.entries(root.deps).map(([depName, range]) => {
				trackCompatGroup(depName, range);
				return { name: depName, range, parentChain: [root.name] };
			});

		while (queue.length > 0) {
			const batch: Array<{
				name: string;
				range: string;
				parentChain: string[];
			}> = [];
			while (queue.length > 0 && batch.length < CONCURRENCY) {
				const dep = queue.shift();
				if (dep === undefined) {
					break;
				}
				const key = visitKey(dep.name, dep.range);
				if (visited.has(key)) {
					continue;
				}
				visited.add(key);
				// Skip if already locked at a satisfying version: npm itself wouldn't
				// touch this dep, so we trust the lockfile and skip the cooldown check.
				const locked = lockedVersions?.get(dep.name);
				if (
					locked !== undefined &&
					locked.some((v) => semver.satisfies(v, dep.range))
				) {
					continue;
				}
				batch.push(dep);
			}
			if (batch.length === 0) {
				continue;
			}

			process.stderr.write(
				batch.map((d) => `  checking ${d.name}...`).join("\n") + "\n",
			);

			let resolved: Awaited<ReturnType<typeof resolvePackageAtDate>>[];
			try {
				resolved = await Promise.all(
					batch.map(({ name, range, parentChain }) =>
						resolvePackageAtDate(
							name,
							snapshotDate,
							majorFromRange(range),
							range,
						).catch((e: unknown) => {
							const msg = e instanceof Error ? e.message : String(e);
							throw new Error(
								`${msg} (required by ${parentChain.join(" -> ")})`,
							);
						}),
					),
				);
			} catch (e: unknown) {
				throw e instanceof Error ? e : new Error(String(e));
			}

			for (let i = 0; i < resolved.length; i++) {
				const {
					name,
					version,
					latestVersion,
					latestPublishTime,
					deps,
					latestDeps,
					needsPin,
					publishTime,
				} = resolved[i];
				const { parentChain } = batch[i];

				if (needsPin === "unavailable") {
					// No historical version exists — block the install unless excepted.
					if (!isException(name, exceptions)) {
						const ageMs = Date.now() - publishTime.getTime();
						tooNew.push({ name, version, daysOld: ageMs / 86400000 });
					}
					continue; // don't walk deps of a package we can't pin
				}

				if (needsPin && !isException(name, exceptions)) {
					let entries = pins.get(name);
					if (entries === undefined) {
						entries = [];
						pins.set(name, entries);
					}
					entries.push({
						version,
						latestVersion,
						latestPublishTime,
						parentChain,
					});
				}

				// Excepted packages aren't pinned, so npm will install their latest
				// version — walk its deps, not the historical version's deps.
				const depsToWalk =
					needsPin && isException(name, exceptions) ? latestDeps : deps;
				for (const [depName, depRange] of Object.entries(depsToWalk)) {
					trackCompatGroup(depName, depRange);
					const key = visitKey(depName, depRange);
					if (!visited.has(key)) {
						queue.push({
							name: depName,
							range: depRange,
							parentChain: [...parentChain, name],
						});
					}
				}
			}
		}
	}

	// Deps required at more than one distinct compat group across the tree.
	const conflictingDeps = new Set(
		[...seenCompatGroups.entries()]
			.filter(([, groups]) => groups.size > 1)
			.map(([name]) => name),
	);

	// Build a flat pinned map (for tests and callers that don't need parent info)
	const pinned = new Map<string, string>(rootPinned);
	for (const [name, entries] of pins) {
		pinned.set(name, entries[0].version);
	}

	return { tooNew, pins, conflictingDeps, pinned, rootPinned, rootDowngraded };
}

/** Build the `overrides` object to write into package.json.
 *
 *  A flat override (`"foo": "1.4.0"`) is used when `foo` is required at a single
 *  compat group across the whole tree.  When `foo` appears at multiple incompatible
 *  groups (`conflictingDeps`), version-qualified flat overrides are used instead
 *  (`"foo@1.x": "1.4.0"`, `"foo@2.x": "2.0.0"`).  This restricts each pin to
 *  resolutions within its own major range, preventing npm's nested-override cascade
 *  from forcing a wrong-major version onto unrelated consumers. */
export function buildTransitiveOverrides(
	pins: Map<string, PinEntry[]>,
	conflictingDeps: Set<string>,
): Record<string, string> {
	const overrides: Record<string, string> = {};

	for (const [name, entries] of pins) {
		if (!conflictingDeps.has(name)) {
			// Single compat group across the tree — plain flat override is safe.
			overrides[name] = entries[0].version;
		} else {
			// Multiple compat groups: use version-qualified flat overrides so each pin
			// only applies to resolutions within its own compat range.
			// For major ≥ 1 the key is "name@N.x"; for major 0 it is "name@0.M.x"
			// because ^0.3.x and ^0.4.x are incompatible ranges.
			const byGroup = new Map<string, string>();
			for (const { version } of entries) {
				const group = compatGroupFromVersion(version);
				if (!byGroup.has(group)) {
					byGroup.set(group, version);
				}
			}
			for (const [group, version] of byGroup) {
				overrides[`${name}@${group}.x`] = version;
			}
		}
	}

	return overrides;
}
