function_description = """Run a shell command in a fresh subshell and return its result."""

import os as _os
import subprocess as _sp


def bash(command, cwd=None, env=None, input=None, timeout=None):
    """Run a shell command and return a CompletedProcess.

    Argument notes:
      command - the shell command string to run.
      cwd     - optional directory to run it in; uses the evaluator's cwd if omitted.
      env     - optional dict of environment variables merged into the current env.
      input   - optional string to feed as stdin.
      timeout - optional timeout in seconds; raises TimeoutExpired if exceeded.

    Result:
      Returns subprocess.CompletedProcess. Read .stdout, .stderr, .returncode.
      Example:  out = bash("git log --oneline"); print(out.returncode, out.stdout)

    Behaviour:
      - Runs via the shell, so pipes/&&/etc. work. Each call runs a FRESH
        subshell: cd, export, and shell variables do NOT carry across calls.
        Hold state in Python variables instead.
      - This is also how you spawn other processes from the workspace.
      - `env` is merged into the current environment, not a replacement, so
        PATH and other needed variables stay available.

    Environment:
      This evaluator runs in a project-local Python venv, not the system
      interpreter. A command that starts python/pip inside the evaluator should
      target the same venv; PATH may point at the system interpreter.
    """
    merged_env = dict(_os.environ)
    if env:
        merged_env.update(env)
    return _sp.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        cwd=cwd,
        input=input,
        timeout=timeout,
        env=merged_env,
        check=False,
    )