export interface Config {
	minimumReleaseAge?: number;
	minimumReleaseAgeExcludes?: string[];
	mode?: "normal" | "paranoid";
}

export interface PackageInfo {
	name: string;
	version: string;
	publishTime: Date;
	deps: Record<string, string>;
}

export interface TooNewEntry {
	name: string;
	version: string;
	daysOld: number;
}

export interface RegistryPackument {
	"dist-tags": Record<string, string>;
	versions: Partial<
		Record<
			string,
			{
				dependencies?: Record<string, string>;
				optionalDependencies?: Record<string, string>;
			}
		>
	>;
	time: Record<string, string>;
}

export interface PackageLockEntry {
	name?: string; // present when the entry is a package alias (npm:real-pkg@range)
	version?: string;
	link?: boolean;
	bundled?: boolean;
}

export interface PackageLockV1Dep {
	version: string;
	dependencies?: Record<string, PackageLockV1Dep>;
}

export interface PackageLock {
	lockfileVersion?: number;
	packages?: Record<string, PackageLockEntry>; // v2/v3
	dependencies?: Record<string, PackageLockV1Dep>; // v1
}

export interface MinimalPackageJson {
	overrides?: Record<string, string | Record<string, string>>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

export interface PinEntry {
	version: string;
	latestVersion: string; // latest (too-new) version that would be installed without pinning
	parentChain: string[]; // ancestry from root dep to direct requiring package
}

export const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;
