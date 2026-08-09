#!/usr/bin/env node
/**
 * postinstall: build the stable per-user Python venv the guest evaluator needs.
 *
 * The guest (src/engine/guest.py) runs a real ipykernel, which requires
 * `ipykernel` + `jupyter_client` installed in a Python environment. When this
 * is installed as a pi package there is no repo-local `.venv` (it's gitignored
 * and excluded from the npm tarball), so we create one at a stable path that
 * the engine also knows about:
 *
 *   ~/.pi/agent/pi-repl/venv/bin/python3
 *
 * Failures are non-fatal: if there's no system python3 or no network, we print
 * a clear notice and let the engine fall back to '$PYTHON' or 'python3' at
 * runtime (where the user is told how to install the deps).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VENV_DIR = join(homedir(), ".pi", "agent", "pi-repl", "venv");
const PY = join(VENV_DIR, "bin", "python3");
const DEPS = ["ipykernel", "jupyter_client"];

function log(msg) {
  process.stdout.write(`[pi-repl] ${msg}\n`);
}
function warn(msg) {
  process.stderr.write(`[pi-repl] warning: ${msg}\n`);
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

function main() {
  // Already built from a previous install/run.
  if (existsSync(PY)) {
    log(`venv already present at ${VENV_DIR}`);
    return;
  }
  const systemPython = findSystemPython();
  if (!systemPython) {
    warn(
      `no python3 found on PATH; could not create the evaluator venv. ` +
        `Install python3 and run '${PY.slice(-60)} -m venv' manually, or set PI_REPL pythonPath.`
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
    warn("You may need to run npm rebuild pi-repl after fixing python/network, or install ipykernel manually.");
  }
}

main();