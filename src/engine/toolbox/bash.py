function_description = """Run a shell command in a fresh subshell and return its result."""

import os as _os
import signal as _sig
import subprocess as _sp


def _kill_group(proc):
    """Kill the whole process group of a child (its shell AND any grandchildren).

    The shell's children inherit the fresh session's id, so they are the only
    ones a timeout must reap; without this a `find | sort` that outlives the
    call would keep chewing CPU long after bash() returned.
    """
    try:
        _os.killpg(_os.getpgid(proc.pid), _sig.SIGKILL)
    except Exception:
        pass


def bash(command, cwd=None, env=None, input=None, timeout=None):
    """Run a shell command and return a CompletedProcess.

    Argument notes:
      command - the shell command string to run.
      cwd     - optional directory to run it in; uses the evaluator's cwd if omitted.
      env     - optional dict of environment variables merged into the current env.
      input   - optional string to feed as stdin.
      timeout - optional timeout in seconds; raises TimeoutExpired (after killing
                the command's whole process group) if exceeded.

    Result:
      Returns subprocess.CompletedProcess. Read .stdout, .stderr, .returncode.
      Example:  out = bash("git log --oneline"); print(out.returncode, out.stdout)

    Behaviour:
      - Runs via the shell, so pipes/&&/etc. work. Each call runs a FRESH
        subshell: cd, export, and shell variables do NOT carry across calls.
        Hold state in Python variables instead.
      - The shell runs in its own process group, so a timeout kills the group —
        no orphaned children keep running afterwards.
      - `env` is merged into the current environment, not a replacement.

    Environment:
      This evaluator runs in a project-local Python venv, not the system
      interpreter. A command that starts python/pip should target the same venv.
    """
    merged_env = dict(_os.environ)
    if env:
        merged_env.update(env)
    with _sp.Popen(
        command,
        shell=True,
        stdin=_sp.PIPE,
        stdout=_sp.PIPE,
        stderr=_sp.PIPE,
        text=True,
        cwd=cwd,
        env=merged_env,
        # --- new session => shell+children form one process group a timeout kills ---
        start_new_session=_os.name == "posix",
    ) as proc:
        try:
            stdout, stderr = proc.communicate(input=input, timeout=timeout)
        except _sp.TimeoutExpired:
            _kill_group(proc)
            try:
                proc.communicate()  # --- drain so no zombie is left ---
            except Exception:
                pass
            raise
    return _sp.CompletedProcess(args=command, returncode=proc.returncode, stdout=stdout, stderr=stderr)