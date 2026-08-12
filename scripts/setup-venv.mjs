#!/usr/bin/env node
/**
 * postinstall: build the stable per-user Python venv the evaluator needs.
 *
 * On a package install the venv is built at a stable path the engine knows:
 *
 *   ~/.pi/agent/pi-repl/venv/bin/python3
 *
 * The venv is repaired in place: if it exists but ipykernel is not importable,
 * this reflushes the venv and reinstalls rather than trusting a half-built one.
 * Failures are NOT silent: a bad build exits non-zero so `npm install` / `pi
 * install` visibly fails instead of leaving a broken evaluator.
 */

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VENV_DIR = join(homedir(), ".pi", "agent", "pi-repl", "venv");
const PY = join(VENV_DIR, "bin", "python3");
const DEPS = ["ipykernel"];
const HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

// A venv that exists but can't import ipykernel is broken. Never trust the
// binary alone — a half-built venv otherwise looks "already up" forever.
function ipykernelOk() {
  try {
    execSync(`${PY} -c "import ipykernel"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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
  if (ipykernelOk()) {
    log(`venv ready (ipykernel present) at ${VENV_DIR}`);
    return;
  }
  const systemPython = findSystemPython();
  if (!systemPython) {
    fail(
      `no python3 found on PATH; could not create the evaluator venv. ` +
        `Install python3 and run '${PY.slice(-60)} -m venv' manually.`
    );
    return;
  }
  log(`building evaluator venv at ${VENV_DIR} (uses ${systemPython})...`);
  try {
    mkdirSync(join(VENV_DIR, ".."), { recursive: true });
    // flush a half-built venv so pip starts from a clean, knowable slate
    execSync(`${systemPython} -m venv --clear ${VENV_DIR}`, { stdio: "inherit" });
    execSync(`${PY} -m pip install --upgrade pip`, { stdio: "inherit" });
    execSync(`${PY} -m pip install ${DEPS.join(" ")}`, { stdio: "inherit" });
    if (!ipykernelOk()) {
      fail(`ipykernel still not importable after install; the evaluator won't start.`);
      return;
    }
    log("done. The pi-repl evaluator will use this venv.");
  } catch (error) {
    // A real failure must not exit 0 with a broken venv. npm/pi will see the
    // nonzero exit and report the install as failed instead of silently
    // handing the user a dead evaluator.
    fail(`could not build the evaluator venv (${error && error.message ? error.message : error}). `);
  }
}

function fail(m) {
  process.stderr.write(`[pi-repl] ERROR: ${m}\n`);
  process.exit(1);
}

main();