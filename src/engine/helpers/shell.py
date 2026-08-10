# shell — the one shipped helper: a low-power block that owns shell's murky part.
#
# It is NOT a tool. It decides none of the work: not the command, not the
# arguments, not how long to wait, not what the output means. It only makes the
# risky subprocess part safe — a command runs in its own process group and, on
# timeout, the WHOLE group is killed, so a hung command can't leave orphaned
# children eating CPU after the cell returns. That murky plumbing is all it
# takes; everything else belongs to the code that writes the `with` block.

helper_description = """shell — a low-power block for running shell commands from the evaluator.
It is NOT a tool that does your job: only the fragile subprocess part is handled
(commands run in their own process group; on timeout the whole group is killed,
so a hung command can't leave orphaned children). You decide the command, the
arguments, the timeout (pass a GENEROUS timeout= for long-running installs or
builds — the evaluator's watchdog backs it), and you do all the parsing and
decisions on the structured result.
Instead of: subprocess.run(cmd, shell=True) with hand-rolled process-group setup,
a killpg on timeout, and fiddly capture flags — this block owns that plumbing.
Usage:
    with shell() as run:
        r = run("git log --oneline -5", timeout=30)
        if r.returncode == 0:
            for line in r.stdout.splitlines():
                print(line)"""

import os as _os
import signal as _sig
import subprocess as _sp


class _Result:
    """A structured command outcome; no raw text plumbing at the caller."""

    __slots__ = ("args", "returncode", "stdout", "stderr")

    def __init__(self, args, returncode, stdout, stderr):
        self.args = args
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    def __repr__(self):
        return f"_Result returncode={self.returncode} (out {len(self.stdout)}B/err {len(self.stderr)}B)"


def _kill_group(proc):
    """Kill the whole process group of a child (its shell AND any grandchildren)."""
    try:
        _os.killpg(_os.getpgid(proc.pid), _sig.SIGKILL)
    except Exception:
        pass


def _run(command, cwd=None, env=None, input=None, timeout=None):
    """Run a command in a fresh subshell; return a _Result. On timeout, kill the group."""
    merged = dict(_os.environ)
    if env:
        merged.update(env)
    with _sp.Popen(
        command,
        shell=True,
        stdin=_sp.PIPE,
        stdout=_sp.PIPE,
        stderr=_sp.PIPE,
        text=True,
        cwd=cwd,
        env=merged,
        # --- fresh session => the shell + its children are one group a timeout can reap ---
        start_new_session=_os.name == "posix",
    ) as proc:
        try:
            stdout, stderr = proc.communicate(input=input, timeout=timeout)
        except _sp.TimeoutExpired:
            _kill_group(proc)
            try:
                proc.communicate()  # drain so no zombie is left behind
            except Exception:
                pass
            raise
    return _Result(command, proc.returncode, stdout, stderr)


class shell:
    """A block-scoped shell fragment; `with shell() as run:` then `run(cmd, timeout=...)`."""

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        # Per-command teardown already happens inside run(); the block just gives
        # the step a local, self-contained scope marker rather than a "tool" feel.
        return False

    def __call__(self, command=None, *, cwd=None, env=None, input=None, timeout=None):
        return _run(command, cwd=cwd, env=env, input=input, timeout=timeout)

    run = __call__  # so `with shell() as run: run("...")` reads naturally
