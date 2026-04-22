#!/usr/bin/env node

// ncd-hero: a full npm wrapper that routes install commands through npm-cooldown.
//
//   alias npm='ncd-hero'
//
// Inspired by https://github.com/lirantal/npq

import { spawnSync } from "child_process";
import { main } from "./index.js";

// All npm aliases for `npm install` (from npm docs).
const INSTALL_SUBCOMMANDS = new Set([
	"install",
	"add",
	"i",
	"in",
	"ins",
	"inst",
	"insta",
	"instal",
	"isnt",
	"isnta",
	"isntal",
	"isntall",
]);

// All npm aliases for `npm ci` (from npm docs).
const CI_SUBCOMMANDS = new Set([
	"ci",
	"clean-install",
	"ic",
	"install-clean",
	"isntall-clean",
]);

const args = process.argv.slice(2);

if (args.includes("--bypass")) {
	const result = spawnSync(
		"npm",
		args.filter((a) => a !== "--bypass"),
		{
			stdio: "inherit",
		},
	);
	process.exit(result.status ?? 1);
}

const command = args[0] ?? "";

const catchMain = () =>
	main().catch((err: unknown) => {
		process.stderr.write(`\nError: ${(err as Error).message}\n`);
		process.exit(1);
	});

if (INSTALL_SUBCOMMANDS.has(command)) {
	process.env.NCD_SUBCOMMAND = "install";
	process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];
	catchMain().catch(() => {});
} else if (CI_SUBCOMMANDS.has(command)) {
	process.env.NCD_SUBCOMMAND = "ci";
	// `npm ci` never accepts package names — forward flags only.
	process.argv = [
		process.argv[0],
		process.argv[1],
		...args.slice(1).filter((a) => a.startsWith("-")),
	];
	catchMain().catch(() => {});
} else {
	// Pass everything else (run, test, publish, audit, …) straight to real npm.
	const result = spawnSync("npm", args, { stdio: "inherit" });
	process.exit(result.status ?? 1);
}
