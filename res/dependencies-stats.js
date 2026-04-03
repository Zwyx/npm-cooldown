#!/usr/bin/env node

// Scans all sibling git repos for commits that added or updated dependencies in package-lock.json
// (includes all transitive dependencies).

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const IGNORED_REPOS = new Set(["some_repository"]);
const IGNORED_ORGANISATION = "@mycompany/";

const reposDir = path.resolve(__dirname);

// Collect all sibling git repos
const repos = fs
	.readdirSync(reposDir, { withFileTypes: true })
	.filter(
		(e) =>
			e.isDirectory() &&
			!IGNORED_REPOS.has(e.name) &&
			fs.existsSync(path.join(reposDir, e.name, ".git")),
	)
	.map((e) => ({ name: e.name, path: path.join(reposDir, e.name) }));

function git(repoPath, cmd) {
	return execSync(`git -C ${JSON.stringify(repoPath)} ${cmd}`, {
		encoding: "utf8",
	});
}

function getFileAtCommit(repoPath, hash, file) {
	try {
		return execSync(`git -C ${JSON.stringify(repoPath)} show ${hash}:${file}`, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		return null;
	}
}

// Returns a flat { name: version } map from a package-lock.json string.
// Supports lockfile v1 (nested `dependencies`) and v2/v3 (flat `packages`).
// For duplicate names (nested installs), the outermost occurrence wins.
function getLockDeps(jsonStr) {
	try {
		const lock = JSON.parse(jsonStr);
		const result = {};
		if (lock.packages) {
			// v2/v3: keys are paths like "node_modules/foo" or "node_modules/a/node_modules/b"
			// Sort by path length so outermost (shortest) entries are processed first
			const entries = Object.entries(lock.packages).sort(
				(a, b) => a[0].length - b[0].length,
			);
			for (const [pkgPath, meta] of entries) {
				if (!pkgPath || !meta.version) continue; // skip root entry
				const name = pkgPath.replace(/.*node_modules\//, "");
				if (!(name in result)) result[name] = meta.version;
			}
		} else if (lock.dependencies) {
			// v1: nested structure
			function flatten(deps) {
				for (const [name, meta] of Object.entries(deps)) {
					if (!(name in result)) result[name] = meta.version;
					if (meta.dependencies) flatten(meta.dependencies);
				}
			}
			flatten(lock.dependencies);
		}
		return result;
	} catch {
		return {};
	}
}

function getChanges(prev, current) {
	return Object.keys(current)
		.filter((k) => !k.startsWith(IGNORED_ORGANISATION))
		.flatMap((k) => {
			if (!(k in prev))
				return [{ name: k, action: "added", from: null, to: current[k] }];
			if (prev[k] !== current[k])
				return [{ name: k, action: "updated", from: prev[k], to: current[k] }];
			return [];
		});
}

function scanRepo(repo) {
	const log = git(
		repo.path,
		'log --format="%H %ai %s" -- package-lock.json',
	).trim();
	if (!log) return [];

	const commits = log
		.split("\n")
		.map((line) => {
			const spaceIdx = line.indexOf(" ");
			const rest = line.slice(spaceIdx + 1);
			const dateEnd = rest.indexOf(" ");
			const timeAndRest = rest.slice(dateEnd + 1);
			const timeEnd = timeAndRest.indexOf(" ");
			const tzAndRest = timeAndRest.slice(timeEnd + 1);
			const tzEnd = tzAndRest.indexOf(" ");
			return {
				hash: line.slice(0, spaceIdx),
				date: rest.slice(0, dateEnd),
				month: rest.slice(0, 7), // YYYY-MM
				subject: tzAndRest.slice(tzEnd + 1),
			};
		})
		.reverse();

	const results = [];
	for (let i = 0; i < commits.length; i++) {
		const commit = commits[i];
		const currentJson = getFileAtCommit(
			repo.path,
			commit.hash,
			"package-lock.json",
		);
		if (!currentJson) continue;

		const current = getLockDeps(currentJson);
		const prev =
			i > 0 ?
				getLockDeps(
					getFileAtCommit(
						repo.path,
						commits[i - 1].hash,
						"package-lock.json",
					) || "{}",
				)
			:	{};

		const changes = getChanges(prev, current);
		if (changes.length > 0) results.push({ commit, changes });
	}
	return results;
}

// Scan all repos
process.stderr.write(`Scanning ${repos.length} repos...\n`);
const allEvents = []; // { month, repo, action, name }

for (const repo of repos) {
	process.stderr.write(`  ${repo.name}\n`);
	try {
		const results = scanRepo(repo);
		for (const { commit, changes } of results) {
			for (const change of changes) {
				allEvents.push({
					month: commit.month,
					repo: repo.name,
					action: change.action,
					name: change.name,
				});
			}
		}
	} catch {
		// skip repos with errors
	}
}

// --- Build stats ---

// Per-month counts
const byMonth = {};
for (const e of allEvents) {
	if (!byMonth[e.month]) byMonth[e.month] = { added: 0, updated: 0 };
	byMonth[e.month][e.action]++;
}
const months = Object.keys(byMonth).sort();

// Per-repo counts
const byRepo = {};
for (const e of allEvents) {
	if (!byRepo[e.repo]) byRepo[e.repo] = { added: 0, updated: 0 };
	byRepo[e.repo][e.action]++;
}
const repoList = Object.entries(byRepo).sort(
	(a, b) => b[1].added + b[1].updated - (a[1].added + a[1].updated),
);

// Most added packages
const addedCounts = {};
for (const e of allEvents.filter((e) => e.action === "added")) {
	addedCounts[e.name] = (addedCounts[e.name] || 0) + 1;
}
const topAdded = Object.entries(addedCounts)
	.sort((a, b) => b[1] - a[1])
	.slice(0, 20);

// Most updated packages
const updatedCounts = {};
for (const e of allEvents.filter((e) => e.action === "updated")) {
	updatedCounts[e.name] = (updatedCounts[e.name] || 0) + 1;
}
const topUpdated = Object.entries(updatedCounts)
	.sort((a, b) => b[1] - a[1])
	.slice(0, 20);

const totalAdded = allEvents.filter((e) => e.action === "added").length;
const totalUpdated = allEvents.filter((e) => e.action === "updated").length;

// --- Output ---
const lines = [];
const out = (s) => lines.push(s ?? "");

out("# Dependencies stats");
out();
out("## Totals");
out();
out(`- Repos scanned: ${repos.length} (${repoList.length} with changes)`);
out(`- Dependencies added: ${totalAdded}`);
out(`- Dependencies updated: ${totalUpdated}`);

out();
out("## Activity per month");
out();
out("| Month | Added | Updated | Total |");
out("|-------|-------|---------|-------|");
for (const m of months) {
	const { added, updated } = byMonth[m];
	out(`| ${m} | ${added} | ${updated} | ${added + updated} |`);
}

out();
out("## Per-repo summary (sorted by total changes)");
out();
out("| Repo | Added | Updated | Total |");
out("|------|-------|---------|-------|");
for (const [repo, { added, updated }] of repoList) {
	out(`| ${repo} | ${added} | ${updated} | ${added + updated} |`);
}

out();
out("## Most commonly added packages (across all repos)");
out();
out("| Package | # times added |");
out("|---------|--------------|");
for (const [name, count] of topAdded) {
	out(`| ${name} | ${count} |`);
}

out();
out("## Most commonly updated packages (across all repos)");
out();
out("| Package | # times updated |");
out("|---------|----------------|");
for (const [name, count] of topUpdated) {
	out(`| ${name} | ${count} |`);
}

console.log(lines.join("\n"));
