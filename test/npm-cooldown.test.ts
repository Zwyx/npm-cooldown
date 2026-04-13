import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawnSync: vi.fn(),
	execSync: vi.fn(),
}));

vi.mock("child_process", () => ({
	spawnSync: mocks.spawnSync,
	execSync: mocks.execSync,
}));

import fs from "fs";

import {
	buildTransitiveOverrides,
	checkAndCollect,
	checkPackageLock,
	clearPackumentCache,
	compareSemver,
	config,
	COOLDOWN_DAYS,
	extractPackagesFromLock,
	isException,
	parsePackageSpec,
} from "../src/check";
import { main } from "../src/index";
import type { PackageLock, PinEntry } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal packument where `version` was published `daysAgo` days ago. */
function makePackument(
	version: string,
	daysAgo: number,
	deps: Record<string, string> = {},
) {
	const publishedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
	return {
		"dist-tags": { latest: version },
		versions: { [version]: { dependencies: deps } },
		time: {
			created: publishedAt,
			modified: publishedAt,
			[version]: publishedAt,
		},
	};
}

/** Stub fetch to return different packuments per package name. */
function stubFetch(
	packuments: Record<string, ReturnType<typeof makePackument>>,
) {
	vi.stubGlobal("fetch", (url: string) => {
		const name = decodeURIComponent(new URL(url).pathname.slice(1));
		const data = packuments[name] as
			| ReturnType<typeof makePackument>
			| undefined;
		if (data === undefined) {
			throw new Error(`Unexpected fetch for ${name}`);
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
	});
}

/** Make spawnSync return a specific resolved version (as npm view would). */
function stubNpmView(version: string) {
	mocks.spawnSync.mockReturnValue({
		status: 0,
		stdout: JSON.stringify(version) + "\n",
		stderr: "",
	});
}

// ---------------------------------------------------------------------------
// isException
// ---------------------------------------------------------------------------

describe("isException", () => {
	it("matches an exact package name", () => {
		expect(isException("react", ["react"])).toBe(true);
		expect(isException("react-dom", ["react"])).toBe(false);
	});

	it("matches all packages under a scope", () => {
		expect(isException("@types/node", ["@types"])).toBe(true);
		expect(isException("@types/react", ["@types"])).toBe(true);
		expect(isException("@babel/core", ["@types"])).toBe(false);
	});

	it("does not match a scope entry against an exact scoped package name", () => {
		// "@types/node" as an exception should only match "@types/node" exactly, not the whole scope
		expect(isException("@types/node", ["@types/node"])).toBe(true);
		expect(isException("@types/react", ["@types/node"])).toBe(false);
	});

	it("returns false for an empty exceptions list", () => {
		expect(isException("react", [])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe("compareSemver", () => {
	it("orders by major", () => {
		expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
		expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
	});

	it("orders by minor when majors are equal", () => {
		expect(compareSemver("1.2.0", "1.1.0")).toBeGreaterThan(0);
		expect(compareSemver("1.1.0", "1.2.0")).toBeLessThan(0);
	});

	it("orders by patch when major and minor are equal", () => {
		expect(compareSemver("1.0.2", "1.0.1")).toBeGreaterThan(0);
	});

	it("returns 0 for equal versions", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
	});

	it("ignores pre-release suffixes when comparing", () => {
		expect(compareSemver("1.0.0-alpha", "0.9.0")).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// parsePackageSpec
// ---------------------------------------------------------------------------

describe("parsePackageSpec", () => {
	it("parses a plain name", () => {
		expect(parsePackageSpec("react")).toEqual({
			name: "react",
			versionHint: "latest",
		});
	});

	it("parses name@version", () => {
		expect(parsePackageSpec("react@18.3.1")).toEqual({
			name: "react",
			versionHint: "18.3.1",
		});
	});

	it("parses name@range", () => {
		expect(parsePackageSpec("react@^18.2.0")).toEqual({
			name: "react",
			versionHint: "^18.2.0",
		});
	});

	it("parses a scoped package", () => {
		expect(parsePackageSpec("@types/node")).toEqual({
			name: "@types/node",
			versionHint: "latest",
		});
	});

	it("parses a scoped package with version", () => {
		expect(parsePackageSpec("@types/node@22.0.0")).toEqual({
			name: "@types/node",
			versionHint: "22.0.0",
		});
	});
});

// ---------------------------------------------------------------------------
// checkAndCollect
// ---------------------------------------------------------------------------

describe("checkAndCollect", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-06-15T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		clearPackumentCache();
	});

	it("passes a package published more than the cooldown period ago", async () => {
		stubNpmView("1.0.0");
		stubFetch({ react: makePackument("1.0.0", COOLDOWN_DAYS * 2) });

		const { tooNew } = await checkAndCollect([
			{ name: "react", versionHint: "latest" },
		]);

		expect(tooNew).toHaveLength(0);
	});

	it("blocks a package published less than the cooldown period ago", async () => {
		stubNpmView("1.0.0");
		stubFetch({ react: makePackument("1.0.0", 3) });

		const { tooNew } = await checkAndCollect([
			{ name: "react", versionHint: "latest" },
		]);

		expect(tooNew).toHaveLength(1);
		expect(tooNew[0]).toMatchObject({ name: "react", version: "1.0.0" });
		expect(tooNew[0].daysOld).toBeCloseTo(3, 0);
	});

	it("resolves deps to the snapshot version (cooldown period ago), not current latest", async () => {
		// react was published COOLDOWN_DAYS*2 days ago and depends on loose-envify
		// loose-envify has two versions: one from COOLDOWN_DAYS*2 days ago, one from 3 days ago
		// The snapshot date is (cooldown period) days ago, so the 3-day-old version must be excluded
		stubNpmView("1.0.0");

		const looseEnvify = {
			"dist-tags": { latest: "1.5.0" },
			versions: {
				"1.4.0": { dependencies: {} },
				"1.5.0": { dependencies: {} },
			},
			time: {
				created: new Date(
					Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
				).toISOString(),
				modified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
				"1.4.0": new Date(
					Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
				).toISOString(),
				"1.5.0": new Date(Date.now() - 3 * 86_400_000).toISOString(),
			},
		};

		stubFetch({
			react: makePackument("1.0.0", COOLDOWN_DAYS * 2, {
				"loose-envify": "^1.0.0",
			}),
			"loose-envify": looseEnvify,
		});

		const { tooNew, pinned } = await checkAndCollect([
			{ name: "react", versionHint: "latest" },
		]);

		expect(tooNew).toHaveLength(0);
		expect(pinned.get("loose-envify")).toBe("1.4.0");
	});

	it("blocks the install when a transitive dep has no version before the snapshot date", async () => {
		// brand-new-dep was only published 3 days ago — no version existed before the snapshot
		stubNpmView("1.0.0");

		const brandNewDep = {
			"dist-tags": { latest: "1.0.0" },
			versions: { "1.0.0": { dependencies: {} } },
			time: {
				created: new Date(Date.now() - 3 * 86_400_000).toISOString(),
				modified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
				"1.0.0": new Date(Date.now() - 3 * 86_400_000).toISOString(),
			},
		};

		stubFetch({
			react: makePackument("1.0.0", COOLDOWN_DAYS * 2, {
				"brand-new-dep": "^1.0.0",
			}),
			"brand-new-dep": brandNewDep,
		});

		const { tooNew } = await checkAndCollect([
			{ name: "react", versionHint: "latest" },
		]);

		expect(tooNew).toHaveLength(1);
		expect(tooNew[0]).toMatchObject({
			name: "brand-new-dep",
			version: "1.0.0",
		});
		expect(tooNew[0].daysOld).toBeCloseTo(3, 0);
	});

	it("blocks when a brand-new transitive dep has no historical version and no exceptions are configured", async () => {
		stubNpmView("1.0.0");

		const aNewDep = {
			"dist-tags": { latest: "1.0.0" },
			versions: { "1.0.0": { dependencies: {} } },
			time: {
				created: new Date(Date.now() - 3 * 86_400_000).toISOString(),
				modified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
				"1.0.0": new Date(Date.now() - 3 * 86_400_000).toISOString(),
			},
		};

		stubFetch({
			react: makePackument("1.0.0", COOLDOWN_DAYS * 2, {
				"a-new-dep": "^1.0.0",
			}),
			"a-new-dep": aNewDep,
		});

		const { tooNew } = await checkAndCollect([
			{ name: "react", versionHint: "latest" },
		]);
		// No exceptions configured — brand-new dep blocks the install
		expect(tooNew).toHaveLength(1);
		expect(tooNew[0]).toMatchObject({ name: "a-new-dep" });
	});

	it("returns pinned map with exact versions for all resolved packages", async () => {
		stubNpmView("18.3.1");
		stubFetch({ react: makePackument("18.3.1", COOLDOWN_DAYS * 2) });

		const { pinned, rootPinned } = await checkAndCollect([
			{ name: "react", versionHint: "latest" },
		]);

		expect(rootPinned.get("react")).toBe("18.3.1");
		expect(pinned.get("react")).toBe("18.3.1");
	});

	// Shared packument for the conflicting-majors tests below.
	// 1.5.0 and 2.1.0 are "too new" (3 days); 1.4.0 and 2.0.0 are old (200 days).
	const sharedWithTwoMajors = (opts: {
		v1TooNew: boolean;
		v2TooNew: boolean;
	}) => ({
		"dist-tags": { latest: "2.1.0" },
		versions: {
			"1.4.0": { dependencies: {} },
			"1.5.0": { dependencies: {} },
			"2.0.0": { dependencies: {} },
			"2.1.0": { dependencies: {} },
		},
		time: {
			created: new Date(
				Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
			).toISOString(),
			modified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
			"1.4.0": new Date(
				Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
			).toISOString(),
			"1.5.0": new Date(
				Date.now() - (opts.v1TooNew ? 3 : COOLDOWN_DAYS * 2) * 86_400_000,
			).toISOString(),
			"2.0.0": new Date(
				Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
			).toISOString(),
			"2.1.0": new Date(
				Date.now() - (opts.v2TooNew ? 3 : COOLDOWN_DAYS * 2) * 86_400_000,
			).toISOString(),
		},
	});

	it("uses version-qualified flat overrides when both majors of a shared dep are too new", async () => {
		stubNpmView("1.0.0");
		stubFetch({
			"pkg-a": makePackument("1.0.0", COOLDOWN_DAYS * 2, { shared: "^1.0.0" }),
			"pkg-b": makePackument("1.0.0", COOLDOWN_DAYS * 2, { shared: "^2.0.0" }),
			shared: sharedWithTwoMajors({ v1TooNew: true, v2TooNew: true }),
		});

		const { tooNew, pins, conflictingDeps } = await checkAndCollect([
			{ name: "pkg-a", versionHint: "latest" },
			{ name: "pkg-b", versionHint: "latest" },
		]);

		expect(tooNew).toHaveLength(0);

		const sharedPins = pins.get("shared") as PinEntry[];
		expect(sharedPins).toHaveLength(2);
		expect(sharedPins).toContainEqual(
			expect.objectContaining({ version: "1.4.0", parentChain: ["pkg-a"] }),
		);
		expect(sharedPins).toContainEqual(
			expect.objectContaining({ version: "2.0.0", parentChain: ["pkg-b"] }),
		);

		expect(conflictingDeps.has("shared")).toBe(true);

		const overrides = buildTransitiveOverrides(pins, conflictingDeps);
		expect(overrides["shared"]).toBeUndefined(); // no plain flat override
		expect(overrides["shared@1.x"]).toBe("1.4.0");
		expect(overrides["shared@2.x"]).toBe("2.0.0");
	});

	it("uses version-qualified flat override when only one major is too new but the dep appears at two majors", async () => {
		// shared@1.x is old enough (no pin needed), shared@2.x is too new.
		// A flat override "shared": "2.0.0" would break pkg-a which requires ^1.0.0.
		stubNpmView("1.0.0");
		stubFetch({
			"pkg-a": makePackument("1.0.0", COOLDOWN_DAYS * 2, { shared: "^1.0.0" }),
			"pkg-b": makePackument("1.0.0", COOLDOWN_DAYS * 2, { shared: "^2.0.0" }),
			shared: sharedWithTwoMajors({ v1TooNew: false, v2TooNew: true }),
		});

		const { tooNew, pins, conflictingDeps } = await checkAndCollect([
			{ name: "pkg-a", versionHint: "latest" },
			{ name: "pkg-b", versionHint: "latest" },
		]);

		expect(tooNew).toHaveLength(0);

		const sharedPins = pins.get("shared") as PinEntry[];
		expect(sharedPins).toHaveLength(1);
		expect(sharedPins[0]).toMatchObject({
			version: "2.0.0",
			parentChain: ["pkg-b"],
		});

		expect(conflictingDeps.has("shared")).toBe(true);

		const overrides = buildTransitiveOverrides(pins, conflictingDeps);
		expect(overrides["shared"]).toBeUndefined(); // no plain flat — would stomp pkg-a's ^1.0.0
		expect(overrides["shared@2.x"]).toBe("2.0.0");
	});

	it("uses version-qualified flat overrides to cover all consumers of a conflicting dep", async () => {
		// shared is conflicting (major 0 from root, major 1 from child-a and child-b).
		// shared@1.5.0 is too new; 1.4.0 is old enough.
		// With version-qualified flat overrides, "shared@1.x": "1.4.0" covers all
		// consumers of shared@^1.x regardless of which parent requires them.
		stubNpmView("1.0.0");

		const sharedMultiMajor = {
			"dist-tags": { latest: "1.5.0" },
			versions: {
				"0.1.0": { dependencies: {} },
				"1.4.0": { dependencies: {} },
				"1.5.0": { dependencies: {} },
			},
			time: {
				created: new Date(
					Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
				).toISOString(),
				modified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
				"0.1.0": new Date(
					Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
				).toISOString(),
				"1.4.0": new Date(
					Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
				).toISOString(),
				"1.5.0": new Date(Date.now() - 3 * 86_400_000).toISOString(),
			},
		};

		stubFetch({
			root: makePackument("1.0.0", COOLDOWN_DAYS * 2, {
				shared: "^0.1.0",
				"child-a": "^1.0.0",
				"child-b": "^1.0.0",
			}),
			"child-a": makePackument("1.0.0", COOLDOWN_DAYS * 2, {
				shared: "^1.0.0",
			}),
			"child-b": makePackument("1.0.0", COOLDOWN_DAYS * 2, {
				shared: "^1.0.0",
			}),
			shared: sharedMultiMajor,
		});

		const { tooNew, pins, conflictingDeps } = await checkAndCollect([
			{ name: "root", versionHint: "latest" },
		]);

		expect(tooNew).toHaveLength(0);
		expect(conflictingDeps.has("shared")).toBe(true);

		// With version-qualified flat overrides, we only need one pin entry per major —
		// the override "shared@1.x": "1.4.0" covers both child-a and child-b automatically.
		const sharedPins = pins.get("shared") as PinEntry[];
		expect(
			sharedPins.some(
				(e) =>
					e.parentChain.includes("child-a") ||
					e.parentChain.includes("child-b"),
			),
		).toBe(true);

		const overrides = buildTransitiveOverrides(pins, conflictingDeps);
		expect(overrides["shared@1.x"]).toBe("1.4.0");
	});

	it("uses a flat override when the same dep at the same major is required by two packages", async () => {
		// Both pkg-a and pkg-b want shared@^1.0.0; no conflict → flat override safe.
		stubNpmView("1.0.0");
		stubFetch({
			"pkg-a": makePackument("1.0.0", COOLDOWN_DAYS * 2, { shared: "^1.0.0" }),
			"pkg-b": makePackument("1.0.0", COOLDOWN_DAYS * 2, { shared: "^1.0.0" }),
			shared: sharedWithTwoMajors({ v1TooNew: true, v2TooNew: false }),
		});

		const { tooNew, pins, conflictingDeps } = await checkAndCollect([
			{ name: "pkg-a", versionHint: "latest" },
			{ name: "pkg-b", versionHint: "latest" },
		]);

		expect(tooNew).toHaveLength(0);
		expect(conflictingDeps.has("shared")).toBe(false);

		const overrides = buildTransitiveOverrides(pins, conflictingDeps);
		expect(overrides["shared"]).toBe("1.4.0"); // flat override is safe
	});

	it("uses version-qualified overrides with 0.minor.x keys for major-0 deps at conflicting minors", async () => {
		// Within major 0, ^0.3.x and ^0.4.x are incompatible ranges (minor is the
		// breaking boundary). A flat override "pkg": "0.4.1" would break any package
		// requiring ^0.3.x, so we must emit "pkg@0.3.x" and "pkg@0.4.x" separately.
		// Both 0.3.x and 0.4.x have a too-new latest version that needs pinning.
		stubNpmView("1.0.0");

		const sharedMajorZero = {
			"dist-tags": { latest: "0.4.1" },
			versions: {
				"0.3.0": { dependencies: {} },
				"0.3.1": { dependencies: {} },
				"0.4.0": { dependencies: {} },
				"0.4.1": { dependencies: {} },
			},
			time: {
				created: new Date(
					Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
				).toISOString(),
				modified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
				"0.3.0": new Date(
					Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
				).toISOString(),
				"0.3.1": new Date(Date.now() - 3 * 86_400_000).toISOString(),
				"0.4.0": new Date(
					Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
				).toISOString(),
				"0.4.1": new Date(Date.now() - 3 * 86_400_000).toISOString(),
			},
		};

		stubFetch({
			"pkg-a": makePackument("1.0.0", COOLDOWN_DAYS * 2, { shared: "^0.3.0" }),
			"pkg-b": makePackument("1.0.0", COOLDOWN_DAYS * 2, { shared: "^0.4.0" }),
			shared: sharedMajorZero,
		});

		const { tooNew, pins, conflictingDeps } = await checkAndCollect([
			{ name: "pkg-a", versionHint: "latest" },
			{ name: "pkg-b", versionHint: "latest" },
		]);

		expect(tooNew).toHaveLength(0);
		expect(conflictingDeps.has("shared")).toBe(true);

		const overrides = buildTransitiveOverrides(pins, conflictingDeps);
		expect(overrides["shared"]).toBeUndefined(); // no plain flat override
		expect(overrides["shared@0.3.x"]).toBe("0.3.0");
		expect(overrides["shared@0.4.x"]).toBe("0.4.0");
	});
});

// ---------------------------------------------------------------------------
// buildTransitiveOverrides
// ---------------------------------------------------------------------------

describe("buildTransitiveOverrides", () => {
	it("uses plain flat override for non-conflicting pinned dep and version-qualified flat for conflicting dep", () => {
		// A is a transitive dep that is itself too new (pinned to 2.9.0) — not conflicting.
		// logger is conflicting (A requires ^1.x, B requires ^2.x) — gets version-qualified
		// flat overrides so the pin for each major doesn't cascade to unrelated consumers.
		const pins = new Map([
			[
				"A",
				[{ version: "2.9.0", latestVersion: "3.0.0", parentChain: ["root"] }],
			],
			[
				"logger",
				[
					{ version: "1.4.0", latestVersion: "1.5.0", parentChain: ["A"] },
					{ version: "2.2.0", latestVersion: "2.3.0", parentChain: ["B"] },
				],
			],
		]);
		const conflictingDeps = new Set(["logger"]);

		const overrides = buildTransitiveOverrides(pins, conflictingDeps);

		expect(overrides["A"]).toBe("2.9.0"); // plain flat — A is not conflicting
		expect(overrides["logger@1.x"]).toBe("1.4.0");
		expect(overrides["logger@2.x"]).toBe("2.2.0");
		expect(overrides["logger"]).toBeUndefined(); // no plain flat override
	});
});

// ---------------------------------------------------------------------------
// extractPackagesFromLock
// ---------------------------------------------------------------------------

describe("extractPackagesFromLock", () => {
	it("extracts packages from a v3 lock file", () => {
		const lock: PackageLock = {
			lockfileVersion: 3,
			packages: {
				"": { version: "1.0.0" },
				"node_modules/react": { version: "18.3.1" },
				"node_modules/scheduler": { version: "0.23.0" },
			},
		};
		expect(extractPackagesFromLock(lock)).toEqual([
			{ name: "react", version: "18.3.1" },
			{ name: "scheduler", version: "0.23.0" },
		]);
	});

	it("handles scoped packages in a v3 lock file", () => {
		const lock: PackageLock = {
			lockfileVersion: 3,
			packages: {
				"node_modules/@types/node": { version: "22.0.0" },
			},
		};
		expect(extractPackagesFromLock(lock)).toEqual([
			{ name: "@types/node", version: "22.0.0" },
		]);
	});

	it("extracts nested packages from a v1 lock file", () => {
		const lock: PackageLock = {
			lockfileVersion: 1,
			dependencies: {
				react: {
					version: "18.3.1",
					dependencies: {
						scheduler: { version: "0.23.0" },
					},
				},
			},
		};
		expect(extractPackagesFromLock(lock)).toEqual([
			{ name: "react", version: "18.3.1" },
			{ name: "scheduler", version: "0.23.0" },
		]);
	});

	it("deduplicates identical name@version entries", () => {
		const lock: PackageLock = {
			lockfileVersion: 3,
			packages: {
				"node_modules/react": { version: "18.3.1" },
				"node_modules/foo/node_modules/react": { version: "18.3.1" },
			},
		};
		expect(extractPackagesFromLock(lock)).toHaveLength(1);
	});

	it("skips linked and bundled entries", () => {
		const lock: PackageLock = {
			lockfileVersion: 3,
			packages: {
				"node_modules/local-pkg": { version: "1.0.0", link: true },
				"node_modules/bundled-pkg": { version: "2.0.0", bundled: true },
				"node_modules/real-pkg": { version: "3.0.0" },
			},
		};
		expect(extractPackagesFromLock(lock)).toEqual([
			{ name: "real-pkg", version: "3.0.0" },
		]);
	});
});

// ---------------------------------------------------------------------------
// main() — dep range handling for downgraded root packages
// ---------------------------------------------------------------------------

describe("main() — dep range handling for downgraded root packages in no-lock mode", () => {
	// Three packages, each representing one case from the dep-range table:
	//   @types/node   ^22.0.0  pinned to 22.19.11 — satisfies ^22.0.0  → temporary
	//   eslint        ^10.1.0  pinned to 10.0.0   — outside  ^10.1.0   → permanent
	//   typescript-eslint ^8.58.0 pinned to 8.56.0 — outside ^8.58.0  → permanent
	const initialPkgJson = {
		devDependencies: {
			"@types/node": "^22.0.0",
			eslint: "^10.1.0",
			"typescript-eslint": "^8.58.0",
		},
	};

	let writtenContents: string[];
	let currentContent: string;
	const originalArgv = process.argv;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-06-15T00:00:00.000Z"));

		writtenContents = [];
		currentContent = JSON.stringify(initialPkgJson, undefined, 2);
		process.argv = ["node", "script.js"]; // no pkg specs → no-lock install path

		vi.spyOn(fs, "existsSync").mockReturnValue(false); // no package-lock.json

		// After --package-lock-only runs, main() reads the lockfile to verify it.
		// Return a clean lockfile containing the three pinned (200-days-old) versions
		// so checkPackageLock passes without triggering the race-condition retry.
		const mockLockfile = JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"node_modules/@types/node": { version: "22.19.11" },
				"node_modules/eslint": { version: "10.0.0" },
				"node_modules/typescript-eslint": { version: "8.56.0" },
			},
		});

		vi.spyOn(fs, "readFileSync").mockImplementation((filePath) => {
			if (String(filePath).endsWith("package.json")) {
				return currentContent;
			}
			if (String(filePath).endsWith("package-lock.json")) {
				return mockLockfile;
			}
			throw new Error(`Unexpected readFileSync: ${String(filePath)}`);
		});

		vi.spyOn(fs, "writeFileSync").mockImplementation((filePath, content) => {
			if (String(filePath).endsWith("package.json")) {
				currentContent = content as string;
				writtenContents.push(content as string);
			}
		});

		mocks.execSync.mockImplementation(() => undefined);

		// Return a too-new "latest" version for each package.
		mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "--version") {
				return { status: 0, stdout: "10.0.0\n", stderr: "" };
			}
			const spec = args[1]; // "name@range"
			let pkgName: string;
			if (spec.startsWith("@")) {
				const rest = spec.slice(1);
				const atIdx = rest.indexOf("@");
				pkgName = atIdx === -1 ? spec : "@" + rest.slice(0, atIdx);
			} else {
				pkgName = spec.split("@")[0];
			}
			const latest: Record<string, string> = {
				"@types/node": "22.20.0",
				eslint: "10.2.0",
				"typescript-eslint": "8.60.0",
			};
			return {
				status: 0,
				stdout: JSON.stringify(latest[pkgName] ?? "1.0.0") + "\n",
				stderr: "",
			};
		});

		// Each packument has one too-new version (3 days) and one old-enough version (COOLDOWN_DAYS * 2 days).
		stubFetch({
			"@types/node": {
				"dist-tags": { latest: "22.20.0" },
				versions: { "22.19.11": { dependencies: {} }, "22.20.0": { dependencies: {} } },
				time: {
					created: new Date(
						Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
					).toISOString(),
					modified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
					"22.19.11": new Date(
						Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
					).toISOString(),
					"22.20.0": new Date(Date.now() - 3 * 86_400_000).toISOString(),
				},
			},
			eslint: {
				"dist-tags": { latest: "10.2.0" },
				versions: { "10.0.0": { dependencies: {} }, "10.2.0": { dependencies: {} } },
				time: {
					created: new Date(
						Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
					).toISOString(),
					modified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
					"10.0.0": new Date(
						Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
					).toISOString(),
					"10.2.0": new Date(Date.now() - 3 * 86_400_000).toISOString(),
				},
			},
			"typescript-eslint": {
				"dist-tags": { latest: "8.60.0" },
				versions: { "8.56.0": { dependencies: {} }, "8.60.0": { dependencies: {} } },
				time: {
					created: new Date(
						Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
					).toISOString(),
					modified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
					"8.56.0": new Date(
						Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
					).toISOString(),
					"8.60.0": new Date(Date.now() - 3 * 86_400_000).toISOString(),
				},
			},
		});
	});

	afterEach(() => {
		process.argv = originalArgv;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		clearPackumentCache();
	});

	it("@types/node: pins to exact version during install, restores original range after (pinned satisfies ^22.0.0)", async () => {
		await main();
		const duringInstall = JSON.parse(writtenContents[0]) as {
			devDependencies: Record<string, string>;
		};
		const afterInstall = JSON.parse(
			writtenContents[writtenContents.length - 1],
		) as { devDependencies: Record<string, string> };
		expect(duringInstall.devDependencies["@types/node"]).toBe("22.19.11");
		expect(afterInstall.devDependencies["@types/node"]).toBe("^22.0.0");
	});

	it("eslint: pins to exact version during install, permanently updates to ^<pinned> after (pinned outside ^10.1.0)", async () => {
		await main();
		const duringInstall = JSON.parse(writtenContents[0]) as {
			devDependencies: Record<string, string>;
		};
		const afterInstall = JSON.parse(
			writtenContents[writtenContents.length - 1],
		) as { devDependencies: Record<string, string> };
		expect(duringInstall.devDependencies["eslint"]).toBe("10.0.0");
		expect(afterInstall.devDependencies["eslint"]).toBe("^10.0.0");
	});

	it("typescript-eslint: pins to exact version during install, permanently updates to ^<pinned> after (pinned outside ^8.58.0)", async () => {
		await main();
		const duringInstall = JSON.parse(writtenContents[0]) as {
			devDependencies: Record<string, string>;
		};
		const afterInstall = JSON.parse(
			writtenContents[writtenContents.length - 1],
		) as { devDependencies: Record<string, string> };
		expect(duringInstall.devDependencies["typescript-eslint"]).toBe("8.56.0");
		expect(afterInstall.devDependencies["typescript-eslint"]).toBe("^8.56.0");
	});

	it("typescript-eslint: no ^ prefix in result when original range had none (8.58.0 → 8.56.0)", async () => {
		// Override initialPkgJson to use an exact version (no ^).
		currentContent = JSON.stringify(
			{
				devDependencies: {
					"@types/node": "^22.0.0",
					eslint: "^10.1.0",
					"typescript-eslint": "8.58.0",
				},
			},
			undefined,
			2,
		);
		await main();
		const afterInstall = JSON.parse(
			writtenContents[writtenContents.length - 1],
		) as { devDependencies: Record<string, string> };
		expect(afterInstall.devDependencies["typescript-eslint"]).toBe("8.56.0");
	});
});

// ---------------------------------------------------------------------------
// checkPackageLock
// ---------------------------------------------------------------------------

describe("checkPackageLock", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-06-15T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		clearPackumentCache();
	});

	it("passes when all locked packages are old enough", async () => {
		stubFetch({ react: makePackument("18.3.1", COOLDOWN_DAYS * 2) });

		const lock: PackageLock = {
			lockfileVersion: 3,
			packages: { "node_modules/react": { version: "18.3.1" } },
		};
		const tooNew = await checkPackageLock(lock);
		expect(tooNew).toHaveLength(0);
	});

	it("blocks when a locked package is too new", async () => {
		stubFetch({ react: makePackument("18.3.1", 3) });

		const lock: PackageLock = {
			lockfileVersion: 3,
			packages: { "node_modules/react": { version: "18.3.1" } },
		};
		const tooNew = await checkPackageLock(lock);
		expect(tooNew).toHaveLength(1);
		expect(tooNew[0]).toMatchObject({ name: "react", version: "18.3.1" });
	});
});

// ---------------------------------------------------------------------------
// main() — lockfile sneak-in retry
// ---------------------------------------------------------------------------

describe("main() — lockfile sneak-in retry", () => {
	const originalArgv = process.argv;

	afterEach(() => {
		process.argv = originalArgv;
		delete config.mode;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		clearPackumentCache();
	});

	it("retries when a just-published transitive dep version sneaks into the lockfile during --package-lock-only resolution", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-06-15T00:00:00.000Z"));

		// ncd react  (package-spec path, no package.json needed)
		process.argv = ["node", "script.js", "react"];

		config.mode = "paranoid";
		vi.spyOn(fs, "existsSync").mockReturnValue(false); // no pre-existing lockfile

		const oldEnoughTime = new Date(
			Date.now() - COOLDOWN_DAYS * 2 * 86_400_000,
		).toISOString();
		const tooNewTime = new Date(Date.now() - 3 * 86_400_000).toISOString();

		// react@19.2.0 depends on dep@^1.0.0. During our initial check, dep@1.0.1 is
		// the latest and is old enough. But while npm is running --package-lock-only,
		// dep@1.0.2 gets published and npm picks it up instead.
		const reactPackument = {
			"dist-tags": { latest: "19.2.0" },
			versions: { "19.2.0": { dependencies: { dep: "^1.0.0" } } },
			time: {
				created: oldEnoughTime,
				modified: oldEnoughTime,
				"19.2.0": oldEnoughTime,
			},
		};

		// First fetch of dep: only 1.0.1 exists, old enough — passes cooldown.
		// Re-fetch of dep (cache bust, triggered because 1.0.2 appeared in the lockfile):
		// 1.0.2 has just been published, too new.
		const depPackumentFirst = {
			"dist-tags": { latest: "1.0.1" },
			versions: { "1.0.1": {} },
			time: {
				created: oldEnoughTime,
				modified: oldEnoughTime,
				"1.0.1": oldEnoughTime,
			},
		};
		const depPackumentSecond = {
			"dist-tags": { latest: "1.0.2" },
			versions: { "1.0.1": {}, "1.0.2": {} },
			time: {
				created: oldEnoughTime,
				modified: tooNewTime,
				"1.0.1": oldEnoughTime,
				"1.0.2": tooNewTime,
			},
		};

		let depFetchCount = 0;
		vi.stubGlobal("fetch", (url: string) => {
			const name = decodeURIComponent(new URL(url).pathname.slice(1));
			if (name === "react") {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(reactPackument),
				});
			}
			if (name === "dep") {
				depFetchCount++;
				const data =
					depFetchCount === 1 ? depPackumentFirst : depPackumentSecond;
				return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
			}
			throw new Error(`Unexpected fetch for ${name}`);
		});

		// npm view resolves "react" → 19.2.0 (used on both attempts)
		mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "--version") {
				return { status: 0, stdout: "10.0.0\n", stderr: "" };
			}
			return { status: 0, stdout: JSON.stringify("19.2.0") + "\n", stderr: "" };
		});

		// First lockfile: npm sneaked in dep@1.0.2 during resolution.
		// Second lockfile: clean, npm settled on dep@1.0.1.
		let lockfileCallCount = 0;
		let pkgJsonContent = "{}";
		vi.spyOn(fs, "readFileSync").mockImplementation((filePath) => {
			if (String(filePath).endsWith("package.json")) {
				return pkgJsonContent;
			}
			if (String(filePath).endsWith("package-lock.json")) {
				lockfileCallCount++;
				if (lockfileCallCount === 1) {
					return JSON.stringify({
						lockfileVersion: 3,
						packages: {
							"node_modules/react": { version: "19.2.0" },
							"node_modules/dep": { version: "1.0.2" },
						},
					});
				}
				return JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"node_modules/react": { version: "19.2.0" },
						"node_modules/dep": { version: "1.0.1" },
					},
				});
			}
			throw new Error(`Unexpected readFileSync: ${String(filePath)}`);
		});
		vi.spyOn(fs, "writeFileSync").mockImplementation((filePath, content) => {
			if (String(filePath).endsWith("package.json")) {
				pkgJsonContent = content as string;
			}
		});
		mocks.execSync.mockImplementation(() => undefined);

		await main();

		const execCalls = mocks.execSync.mock.calls as string[][];
		const lockOnlyCalls = execCalls.filter((args) =>
			args[0].includes("--package-lock-only"),
		);
		const ciCalls = execCalls.filter((args) => args[0].startsWith("npm ci"));

		// First attempt: dep@1.0.2 sneaks in → retry. Second attempt: dep@1.0.1 is clean → npm ci.
		expect(lockOnlyCalls).toHaveLength(2);
		expect(ciCalls).toHaveLength(1);
		// dep packument fetched twice: initial check (1.0.1 ok) + cache-bust re-fetch (1.0.2 too new).
		expect(depFetchCount).toBe(2);
	});
});
