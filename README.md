# npm-cooldown

Wraps `npm install` and **installs packages and their dependencies as they were N days ago**.

Supply chain attacks often exploit the window between a malicious publish and community detection. Waiting a few days before installing a new or updated package gives that window time to close.

## Example

Run `npm install eslint` to install ESLint and its dependencies as they were 7 days ago:

```
$ npm install eslint
Cooldown check (7 days) for: eslint
Resolving root packages...
  eslint@10.2.0 is only 5.6d old -> using 10.1.0 instead
  checking ajv...
  checking debug...
  checking espree...
  ...

All packages passed the cooldown check.

Pinning 4 transitive deps to versions available as of 2026-04-12:
  @eslint/core@1.2.1 -> 1.1.1 (required by eslint)
  @eslint/config-array@0.23.5 -> 0.23.3 (required by eslint)
  @eslint/config-helpers@0.5.5 -> 0.5.3 (required by eslint)
  @eslint/object-schema@3.0.5 -> 3.0.3 (required by eslint -> @eslint/config-array)

Running: npm install eslint@10.1.0

added 68 packages, and audited 69 packages in 681ms

16 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

After this, `package.json` contains `"eslint": "^10.1.0"`, and `package-lock.json` only includes dependencies published at least 7 days ago – exactly as if `npm install eslint` was run on this date.

## Requirements

- **Node.js ≥ 18** (for the built-in `fetch` global, introduced in Node 18)
- **npm ≥ `8.3.0`** (for the `overrides` field used for transitive pinning, introduced in npm `8.3.0` – note: npm-cooldown uses this field only temporarily, and restores it to its original state)

## Installation

> You can try out the tool without installing it – see the [Usage](#usage) section.

```sh
npm i -g npm-cooldown
```

Then add this to your shell profile (`.bashrc`, `.zshrc`, etc.):

```sh
alias npm='ncd-hero'
```

`ncd-hero` intercepts `npm install` and `npm ci` (and their aliases) and routes them through npm-cooldown. Every other npm command — `run`, `test`, `publish`, etc. — is passed straight through to real npm. From this point on, every `npm install` you run is automatically cooldown-checked, with no change to your workflow.

Alternatively, you can use the `ncd` shorthand directly.

### With NVM

With [NVM](https://github.com/nvm-sh/nvm), add `npm-cooldown` to `~/.nvm/default-packages` to automatically install `npm-cooldown` when installing a new Node version.

And run the following to install `npm-cooldown` for all the Node versions already present on your system:

```sh
for version in $(nvm list --no-colors | grep '  v' | sed 's/->//' | sed 's/ *v//' | awk '{print $1}'); do
	nvm use $version
	npm i -g npm-cooldown
done
```

## Usage

All flags are passed through to the underlying npm command (`--save-dev`, etc.).

### Install a package and its dependencies as they were N days ago

```sh
npm install eslint
# or: ncd eslint
# or without installing the tool: npx npm-cooldown eslint
```

Resolves, checks, and installs the most recent version of the package that is at least N days old. Transitive dependencies are automatically pinned to their N-day-old versions.

### Install from `package.json` (no lockfile)

```sh
npm install
# or: ncd
# or: npx npm-cooldown
```

Resolves all dependencies in `package.json`, pins any that are too new, and runs `npm install`.

### `npm install` with a lockfile, and `npm ci`

In [normal mode](#normal-vs-paranoid-mode) these pass straight through to real npm unchanged — the cooldown check already happened when the lockfile was created. In [paranoid mode](#normal-vs-paranoid-mode), every locked package is verified against the cooldown threshold before running.

### Flags

| Flag         | Description                                                                             |
| ------------ | --------------------------------------------------------------------------------------- |
| `--paranoid` | Activates [paranoid mode](#normal-vs-paranoid-mode) for this run, regardless of config. |
| `--bypass`   | Skips npm-cooldown entirely and calls real npm directly.                                |

```sh
npm --bypass install -g my-package.tgz     # skip cooldown, call npm directly
```

## How it works

### `npm install eslint`

1. Resolves the exact version that would be installed.
2. If the latest version is too new, falls back to the most recent version that passes the cooldown – aborts if no such version exists.
3. Walks the full transitive dependency tree, resolving each dep to the highest stable version that existed N days ago.
4. Writes the pinned versions to `package.json`'s `overrides` field, runs `npm install eslint@<version>`.
5. Removes the `overrides` field from `package.json` – **effectively leaving `package.json` and `package-lock.json` in the state they would have been had `npm install eslint` been run N days ago**.

### `npm install` with no lockfile

Same steps as above but for all dependencies in `package.json` at once. When a dependency's range needs to be pinned to an older version, npm-cooldown temporarily sets it to the exact pinned version in `package.json` during the install (npm doesn't support `overrides` for direct dependencies), then restores the file – keeping the change permanent only if the pinned version falls outside the original range.

### `npm install` with a lockfile, and `npm ci`

In normal mode, these are passed through to real npm unchanged.

In paranoid mode, every locked package is checked against the cooldown threshold, and npm is only invoked if all pass.

## Configuration

Create a `.npm-cooldown_config` JSON file in your home directory (global) or project directory (local override):

```jsonc
{
	"minimumReleaseAge": 14,
	"minimumReleaseAgeExcludes": ["eslint", "@mycompany"],
	"mode": "paranoid",
}
```

| Option                      | Type                       | Default    | Description                                                                                                                                           |
| --------------------------- | -------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimumReleaseAge`         | number                     | `7`        | Minimum age in days a package must be before it can be installed.                                                                                     |
| `minimumReleaseAgeExcludes` | string[]                   | `[]`       | Packages or scopes that bypass the age check. A bare scope like `@mycompany` matches all packages under that scope; anything else is matched exactly. |
| `mode`                      | `"normal"` \| `"paranoid"` | `"normal"` | See below.                                                                                                                                            |

### Normal vs paranoid mode

In **normal mode** (the default), npm-cooldown resolves the dependency tree, pins any too-new transitive deps via overrides, and runs `npm install` directly. `npm install` with a lockfile and `npm ci` are passed through to real npm unchanged.

This creates a small race window between the cooldown check and the actual install during which a new version could be published and picked up by npm.

**Paranoid mode** closes this by running `npm install --package-lock-only` first to resolve the lockfile without downloading any dependencies, verifying the resulting lockfile, and only then running `npm ci` to install from the verified lockfile. If anything slipped in during npm's resolution (e.g. a package was published in that split-second window), npm-cooldown redoes the checks with the new information and retries. `npm install` with a lockfile and `npm ci` also verify every locked package before running.

Paranoid mode can be set permanently in config, or activated for a single run with `--paranoid`.

The project-level config is merged on top of the global one, so you can set a global default and tighten or loosen it per project.

## Alternatives

As of April 2026.

### pnpm

Supports [`minimumReleaseAge`](https://pnpm.io/settings#minimumreleaseage) and `minimumReleaseAgeExclude`.

### Bun

Supports [`minimumReleaseAge`](https://bun.com/docs/pm/cli/install#minimum-release-age) and `minimumReleaseAgeExcludes`.

### npm ≥ 11

Supports [`min-release-age`](https://docs.npmjs.com/cli/v11/commands/npm-install#min-release-age) and [`before`](https://docs.npmjs.com/cli/v11/commands/npm-install#before) but doesn't support any exclude option.
