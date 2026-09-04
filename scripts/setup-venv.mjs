#!/usr/bin/env node
/** postinstall: build the stable per-user venv at ~/.pi/agent/pi-repl/venv; repair in place if ipykernel is missing; a bad build fails the install loudly. */

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VENV_DIR = join(homedir(), ".pi", "agent", "pi-repl", "venv");
const PY = join(VENV_DIR, "bin", "python3");
const DEPS = ["ipykernel", "cloudpickle"];
const HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

// A venv that can't import ipykernel is broken — never trust the binary alone.
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

// --- helpers dir: user-owned, created empty; existing files are never clobbered ---
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
    // a real failure must exit non-zero — never hand the user a dead evaluator
    fail(`could not build the evaluator venv (${error && error.message ? error.message : error}). `);
  }
}

function fail(m) {
  process.stderr.write(`[pi-repl] ERROR: ${m}\n`);
  process.exit(1);
}

main();
