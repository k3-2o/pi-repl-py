#!/usr/bin/env node
/**
 * postinstall: build the stable per-user Python venv the evaluator needs.
 *
 * The evaluator (src/engine/kernel.ts) drives a real ipykernel directly over
 * the Jupyter protocol; `ipykernel` is the only hard runtime dependency. When
 * this is installed as a pi package there is no repo-local `.venv` (gitignored
 * and excluded from the npm tarball), so we create one at a stable path the
 * engine also knows about:
 *
 *   ~/.pi/agent/pi-repl/venv/bin/python3
 *
 * HELPERS live ONLY in the user-owned config dir:
 *
 *   ~/.pi/agent/pi-repl/helpers/
 *
 * There is no helper/config folder anywhere in this package (no
 * src/engine/helpers, no templates/). The helpers dir is created if missing,
 * but no default helpers are seeded — the REPL itself already provides shell
 * (via `!cmd`, `%%bash`, `subprocess`) and file IO (via `open`, `pathlib`).
 * Users add their own helper .py files freely; existing files are never clobbered.
 *
 * Failures are non-fatal: if there's no system python3 or no network we print a
 * clear notice and let the engine fall back to '$PYTHON' or 'python3' at runtime.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VENV_DIR = join(homedir(), ".pi", "agent", "pi-repl", "venv");
const PY = join(VENV_DIR, "bin", "python3");
const DEPS = ["ipykernel"];
const HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

function log(m) {
  process.stdout.write(`[pi-repl] ${m}\n`);
}
function warn(m) {
  process.stderr.write(`[pi-repl] warning: ${m}\n`);
}

function findSystemPython() {
  for (const cand of ["python3", "python"]) {
    try {
      execSync(`${cand} --version`, { stdio: "ignore" });
      return cand;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- helpers dir
// The helpers dir is user-owned. We create it empty on install. The REPL
// provides shell and file IO natively; helpers are for things the user adds
// themselves (e.g. web_search, custom skills). Existing files are never clobbered.
function seedHelpersDir() {
  try {
    mkdirSync(HELPERS_DIR, { recursive: true });
  } catch (e) {
    warn(`could not create the helpers dir (${e?.message ?? e}); custom helpers won't preload.`);
  }
}

function main() {
  seedHelpersDir();
  if (existsSync(PY)) {
    log(`venv already present at ${VENV_DIR}`);
    return;
  }
  const systemPython = findSystemPython();
  if (!systemPython) {
    warn(
      `no python3 found on PATH; could not create the evaluator venv. ` +
        `Install python3 and run '${PY.slice(-60)} -m venv' manually, or set $PYTHON to point at one.`
    );
    return;
  }
  log(`creating evaluator venv at ${VENV_DIR} (uses ${systemPython})...`);
  try {
    mkdirSync(join(VENV_DIR, ".."), { recursive: true });
    execSync(`${systemPython} -m venv ${VENV_DIR}`, { stdio: "inherit" });
    execSync(`${PY} -m pip install --upgrade pip`, { stdio: "inherit" });
    execSync(`${PY} -m pip install ${DEPS.join(" ")}`, { stdio: "inherit" });
    log("done. The pi-repl evaluator will use this venv.");
  } catch (error) {
    warn(`could not build the evaluator venv (${error && error.message ? error.message : error}). `);
    warn("You must install ipykernel in that venv before the evaluator runs.");
  }
}

main();