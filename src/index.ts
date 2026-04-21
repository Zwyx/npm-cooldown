#!/usr/bin/env node

// Run `npm run dev` to quickly run the code

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import semver from "semver";

import {
	buildTransitiveOverrides,
	checkAndCollect,
	checkPackageLock,
	config,
	COOLDOWN_DAYS,
	COOLDOWN_MS,
	parsePackageSpec,
} from "./check.js";

import {
	DEP_FIELDS,
	type MinimalPackageJson,
	type PackageLock,
	type PinEntry,
} from "./types.js";

function detectIndent(contents: string): string | number {
	const match = contents.match(/^([ \t]+)/m);
	if (!match) {
		return 2;
	}
	return match[1].startsWith("\t") ? "\t" : match[1].length;
}

function printBlocked(
	tooNew: Array<{ name: string; version: string; daysOld: number }>,
	showLockfileHint = true,
): void {
	process.stderr.write("\nBlocked — packages still in cooldown:\n");
	for (const { name, version, daysOld } of tooNew) {
		const remaining = (COOLDOWN_DAYS - daysOld).toFixed(1);
		process.stderr.write(
			`  ${name}@${version}  (${daysOld.toFixed(1)}d old, ${remaining}d remaining)\n`,
		);
	}
	if (showLockfileHint) {
		process.stderr.write(
			"\nInstall aborted. Delete 'package-lock.json' and rerun npm-cooldown to make it downgrade necessary dependencies.\n",
		);
	}
}

function printPins(pins: Map<string, PinEntry[]>): void {
	const snapshotDate = new Date(Date.now() - COOLDOWN_MS);
	process.stderr.write(
		`\nPinning ${String(pins.size)} transitive deps to versions available as of ${snapshotDate.toISOString().slice(0, 10)}:\n`,
	);
	for (const [name, entries] of pins) {
		for (const { version, latestVersion, parentChain } of entries) {
			process.stderr.write(
				`  ${name}@${latestVersion} -> ${version} (required by ${parentChain.join(" -> ")})\n`,
			);
		}
	}
}

export async function main(): Promise<void> {
	const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
	if (nodeMajor < 18) {
		process.stderr.write(
			`Error: npm-cooldown requires Node.js >= 18 (current: ${process.versions.node})\n`,
		);
		process.exit(1);
	}

	const npmVersionResult = spawnSync("npm", ["--version"], { encoding: "utf8" });
	if (
		npmVersionResult.status !== 0 ||
		semver.lt(npmVersionResult.stdout.trim(), "8.3.0")
	) {
		process.stderr.write(
			`Error: npm-cooldown requires npm >= 8.3.0 (current: ${npmVersionResult.stdout.trim() || "unknown"})\n`,
		);
		process.exit(1);
	}

	const args = process.argv.slice(2);
	const hasParanoidFlag = args.includes("--paranoid");
	const flags = args.filter((a) => a.startsWith("-") && a !== "--paranoid");
	const pkgSpecs = args.filter((a) => !a.startsWith("-"));
	const isParanoid = hasParanoidFlag || config.mode === "paranoid";

	if (flags.includes("-g") || flags.includes("--global")) {
		process.stderr.write(
			"npm-cooldown does not support global installs (no package.json to apply overrides).\n" +
				"Use --bypass to call npm directly: npm --bypass install -g <package>\n",
		);
		process.exit(1);
	}

	// Lockfile path — in paranoid mode: verify every locked version against the cooldown,
	// then run npm ci. In normal mode: pass through directly to npm unchanged.
	if (pkgSpecs.length === 0) {
		const lockPath = path.resolve("package-lock.json");
		if (fs.existsSync(lockPath)) {
			if (!isParanoid) {
				const subcommand = process.env.NCD_SUBCOMMAND ?? "ci";
				const cmd = `npm ${subcommand} ${flags.join(" ")}`.trim();
				process.stderr.write(`Running: ${cmd}\n`);
				execSync(cmd, { stdio: "inherit" });
				return;
			}
			process.stderr.write(
				`Cooldown check (${String(COOLDOWN_DAYS)} days) for all packages in package-lock.json...\n`,
			);
			const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as PackageLock;
			const tooNew = await checkPackageLock(lock);
			if (tooNew.length > 0) {
				printBlocked(tooNew);
				process.exit(1);
			}
			process.stderr.write("\nAll packages passed the cooldown check.\n");
			const ciCmd = `npm ci ${flags.join(" ")}`.trim();
			process.stderr.write(`\nRunning: ${ciCmd}\n`);
			execSync(ciCmd, { stdio: "inherit" });
			return;
		}
		process.stderr.write(
			"No package-lock.json — resolving dependency tree...\n",
		);
	}

	// In paranoid mode, when adding specific packages and a lockfile already exists,
	// verify all existing packages pass cooldown before touching anything.
	if (pkgSpecs.length > 0 && isParanoid) {
		const lockPath = path.resolve("package-lock.json");
		if (fs.existsSync(lockPath)) {
			process.stderr.write(
				`Cooldown check (${String(COOLDOWN_DAYS)} days) for existing packages in package-lock.json...\n`,
			);
			const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as PackageLock;
			const tooNew = await checkPackageLock(lock);
			if (tooNew.length > 0) {
				printBlocked(tooNew);
				process.exit(1);
			}
			process.stderr.write(
				"\nAll existing packages passed the cooldown check.\n",
			);
		}
	}

	// Install path — resolve the dep tree, pin too-new transitive deps, then install.
	const pkgJsonPath = path.resolve("package.json");
	let originalContents: string | undefined;
	try {
		originalContents = fs.readFileSync(pkgJsonPath, "utf8");
	} catch {
		// ignore — package.json may not exist
	}
	const indent =
		originalContents !== undefined ? detectIndent(originalContents) : 2;

	// Outer retry loop (paranoid mode only): if a package is published during npm's
	// resolution it could sneak into the lockfile. We detect this by running
	// `--package-lock-only` first, verifying the resulting lockfile, and only
	// then running `npm ci`. On a hit we redo all checks from scratch and retry.
	// In normal mode the loop always exits on the first iteration.
	const MAX_RETRIES = 5;
	let firstSneakedInKeys: Set<string> | undefined;
	let lastSneakedIn: Array<{ name: string; version: string; daysOld: number }> =
		[];
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const pkgJson: MinimalPackageJson =
			originalContents !== undefined ?
				(JSON.parse(originalContents) as MinimalPackageJson)
			:	{};

		// Snapshot of dep ranges before the downgrade loop can modify them.
		// Used later to decide whether a downgraded version is a permanent change.
		const originalRanges = new Map<string, string>();
		for (const field of DEP_FIELDS) {
			for (const [name, range] of Object.entries(pkgJson[field] ?? {})) {
				originalRanges.set(name, range);
			}
		}

		let specs: Array<{ name: string; versionHint: string }>;
		if (pkgSpecs.length > 0) {
			process.stderr.write(
				`Cooldown check (${String(COOLDOWN_DAYS)} days) for: ${pkgSpecs.join(", ")}\n`,
			);
			specs = pkgSpecs.map(parsePackageSpec);
		} else {
			process.stderr.write(
				`\nCooldown check (${String(COOLDOWN_DAYS)} days) for all dependencies...\n`,
			);
			specs = DEP_FIELDS.flatMap((field) => {
				const deps = pkgJson[field];
				return Object.entries(deps ?? {}).map(([name, range]) => ({
					name,
					versionHint: range,
				}));
			});
		}

		let { tooNew, pins, conflictingDeps, rootPinned, rootDowngraded } =
			await checkAndCollect(specs);

		while (tooNew.length > 0) {
			// Packages are auto-downgradeable if they are a root/direct dep and have a
			// previous major to fall back to.
			const toDowngrade = tooNew.filter(({ name, version }) => {
				const isRoot =
					pkgSpecs.length > 0 ?
						specs.some((s) => s.name === name)
					:	DEP_FIELDS.some((f) => pkgJson[f]?.[name] !== undefined);
				return isRoot && semver.major(version) > 0;
			});

			printBlocked(tooNew, false);

			if (toDowngrade.length !== tooNew.length) {
				// Some blocked packages are transitive deps or at major 0 — can't auto-downgrade.
				process.exit(1);
			}

			process.stderr.write(
				`\nRetrying with: ${toDowngrade.map(({ name, version }) => `${name}@${String(semver.major(version) - 1)}`).join(", ")}...\n`,
			);

			for (const { name, version } of toDowngrade) {
				const prevMajor = semver.major(version) - 1;
				if (pkgSpecs.length > 0) {
					specs = specs.map((s) =>
						s.name === name ? { ...s, versionHint: String(prevMajor) } : s,
					);
				} else {
					for (const field of DEP_FIELDS) {
						const deps = pkgJson[field];
						if (deps !== undefined && name in deps) {
							deps[name] = `^${String(prevMajor)}`;
							break;
						}
					}
				}
			}

			if (pkgSpecs.length === 0) {
				specs = DEP_FIELDS.flatMap((field) => {
					const deps = pkgJson[field];
					return Object.entries(deps ?? {}).map(([depName, range]) => ({
						name: depName,
						versionHint: range,
					}));
				});
			}

			({ tooNew, pins, conflictingDeps, rootPinned, rootDowngraded } =
				await checkAndCollect(specs));
		}

		process.stderr.write("\nAll packages passed the cooldown check.\n");

		if (pins.size > 0) {
			printPins(pins);
		}

		const savedOverrides = pkgJson.overrides;

		// For root packages that need downgrading, overrides can't be used because npm
		// raises EOVERRIDE for direct dependencies.  Instead we temporarily set the dep
		// range to the exact pinned version (no `^`) so npm installs precisely that version,
		// then fix up the range in the finally block:
		//   - If the pinned version satisfies the existing range (e.g. @types/node@22.19.11
		//     satisfies ^22.0.0) → restore the original range (no permanent change).
		//   - If the pinned version does NOT satisfy the existing range (e.g. eslint@10.0.0
		//     does not satisfy ^10.1.0) → write ^<pinned> (permanent, mirrors what would
		//     have been committed had the install run N days ago).
		const savedDepRanges = new Map<
			string,
			{ field: string; range: string; permanent: boolean }
		>();
		if (pkgSpecs.length === 0) {
			for (const [name, version] of rootDowngraded) {
				const directField = DEP_FIELDS.find(
					(f) => pkgJson[f]?.[name] !== undefined,
				);
				if (directField !== undefined) {
					const originalRange =
						originalRanges.get(name) ??
						(pkgJson[directField] as Record<string, string>)[name];
					savedDepRanges.set(name, {
						field: directField,
						range: originalRange,
						permanent: !semver.satisfies(version, originalRange),
					});
					// Use exact version during install so npm doesn't resolve a newer patch.
					(pkgJson[directField] as Record<string, string>)[name] = version;
				}
			}
		}

		// Transitive pins for packages that are also direct dependencies cannot use
		// overrides — npm raises EOVERRIDE. Handle them the same way as rootDowngraded:
		// temporarily set the exact pinned version in package.json, then restore after.
		for (const [name, entries] of [...pins.entries()]) {
			const directField = DEP_FIELDS.find(
				(f) => pkgJson[f]?.[name] !== undefined,
			);
			if (directField !== undefined && !savedDepRanges.has(name)) {
				const pinnedVersion = entries[0].version;
				const originalRange =
					originalRanges.get(name) ??
					(pkgJson[directField] as Record<string, string>)[name];
				savedDepRanges.set(name, {
					field: directField,
					range: originalRange,
					permanent: !semver.satisfies(pinnedVersion, originalRange),
				});
				rootDowngraded.set(name, pinnedVersion);
				(pkgJson[directField] as Record<string, string>)[name] = pinnedVersion;
				pins.delete(name);
			}
		}

		pkgJson.overrides = {
			...savedOverrides,
			...buildTransitiveOverrides(pins, conflictingDeps),
		};
		fs.writeFileSync(
			pkgJsonPath,
			JSON.stringify(pkgJson, undefined, indent) + "\n",
		);

		try {
			if (!isParanoid) {
				// Normal mode: run npm install directly with the pinned versions.
				const installCmd =
					pkgSpecs.length > 0 ?
						`npm install ${[...flags, ...[...rootPinned.entries()].map(([n, v]) => `${n}@${v}`)].join(" ")}`
					:	`npm install ${flags.join(" ")}`.trim();
				process.stderr.write(`\nRunning: ${installCmd}\n`);
				execSync(installCmd, { stdio: "inherit" });
				return;
			}

			// Paranoid mode:
			// Step 1: resolve the lockfile without downloading anything.
			const lockOnlyCmd =
				pkgSpecs.length > 0 ?
					`npm install --package-lock-only ${[...flags, ...[...rootPinned.entries()].map(([n, v]) => `${n}@${v}`)].join(" ")}`
				:	`npm install --package-lock-only ${flags.join(" ")}`.trim();
			process.stderr.write(`\nRunning: ${lockOnlyCmd}\n`);
			execSync(lockOnlyCmd, { stdio: "inherit" });

			// Step 2: verify the lockfile — a package published while npm was resolving
			// could have sneaked in past our checks.
			const lockPath = path.resolve("package-lock.json");
			const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as PackageLock;
			process.stderr.write(
				"\nVerifying generated lockfile against cooldown...\n",
			);
			const sneakedIn = await checkPackageLock(lock);
			if (sneakedIn.length > 0) {
				const prevKeys = new Set(
					lastSneakedIn.map(({ name, version }) => `${name}@${version}`),
				);
				const hasNewEntries = sneakedIn.some(
					({ name, version }) => !prevKeys.has(`${name}@${version}`),
				);
				if (firstSneakedInKeys === undefined) {
					firstSneakedInKeys = new Set(
						sneakedIn.map(({ name, version }) => `${name}@${version}`),
					);
				}
				lastSneakedIn = sneakedIn;
				if (!hasNewEntries) {
					// Same packages on consecutive checks — not a race condition, bail out.
					break;
				}
				process.stderr.write(
					`\n${String(sneakedIn.length)} package(s) appeared during resolution — retrying (attempt ${String(attempt + 1)}/${String(MAX_RETRIES)})...\n`,
				);
				continue; // finally will restore package.json before the next attempt
			}

			// Step 3: lockfile is clean — install from it.
			const ciCmd = `npm ci ${flags.join(" ")}`.trim();
			process.stderr.write(`\nRunning: ${ciCmd}\n`);
			execSync(ciCmd, { stdio: "inherit" });
			return;
		} finally {
			try {
				const current = JSON.parse(
					fs.readFileSync(pkgJsonPath, "utf8"),
				) as MinimalPackageJson;
				if (savedOverrides !== undefined) {
					current.overrides = savedOverrides;
				} else {
					delete current.overrides;
				}
				for (const [name, { field, range, permanent }] of savedDepRanges) {
					const deps = current[field as keyof MinimalPackageJson] as
						| Record<string, string>
						| undefined;
					const pinnedVersion = rootDowngraded.get(name);
					if (deps?.[name] !== undefined && pinnedVersion !== undefined) {
						// permanent: write ^<pinned> (range was too narrow for the pinned version)
						// temporary: restore original range (pinned version already satisfied it)
						const prefix = /^[~^]/.test(range) ? range[0] : "";
						deps[name] = permanent ? `${prefix}${pinnedVersion}` : range;
					}
				}
				fs.writeFileSync(
					pkgJsonPath,
					JSON.stringify(current, undefined, indent) + "\n",
				);
			} catch {
				// ignore — package.json may no longer exist
			}
		}
	}
	const hasGenuineSneakIn = lastSneakedIn.some(
		({ name, version }) => !firstSneakedInKeys?.has(`${name}@${version}`),
	);
	if (hasGenuineSneakIn) {
		throw new Error(
			`Packages kept appearing in the lockfile after ${String(MAX_RETRIES)} attempts — install aborted.`,
		);
	}
	printBlocked(lastSneakedIn);
	process.exit(1);
}

if (require.main === module) {
	main().catch((err: unknown) => {
		process.stderr.write(`\nError: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
