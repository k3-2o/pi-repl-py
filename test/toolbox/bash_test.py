"""Direct unit tests for the bash toolbox function.

These exercise the bash() implementation without driving the guest protocol.
The guest contract still has a basic integration smoke test; this file covers
the new optional parameters (env, input, cwd, timeout).
"""

import os
import subprocess
import tempfile
import time

import pytest

# src/ is on sys.path via test/conftest.py, so engine.toolbox.bash imports as a
# namespace package even though the toolbox dir has no __init__.py.
from engine.toolbox.bash import bash


def test_bash_runs_simple_command():
    result = bash("echo toolbox-ok")
    assert result.returncode == 0
    assert result.stdout.strip() == "toolbox-ok"


def test_bash_accepts_stdin_input():
    result = bash("cat", input="hello")
    assert result.returncode == 0
    assert result.stdout == "hello"


def test_bash_merges_extra_env_variables():
    result = bash("echo $PI_REPL_TEST_ENV", env={"PI_REPL_TEST_ENV": "set"})
    assert result.returncode == 0
    assert result.stdout.strip() == "set"
    # The merge must not clobber the existing environment.
    result2 = bash("echo $PATH")
    assert result2.returncode == 0
    assert result2.stdout.strip()


def test_bash_changes_working_directory():
    tmp = tempfile.mkdtemp()
    result = bash("pwd", cwd=tmp)
    assert result.returncode == 0
    assert result.stdout.strip() == tmp


def test_bash_honors_timeout():
    start = time.time()
    with pytest.raises(subprocess.TimeoutExpired):
        bash("sleep 5", timeout=0.1)
    elapsed = time.time() - start
    assert elapsed < 1.0


def test_bash_timeout_kills_the_whole_process_group():
    # A timed-out bash must reap the shell's children too, or a background
    # `find`/`sort`/sleep would keep running long after the call returned.
    marker = os.path.join(tempfile.mkdtemp(), "late.txt")
    with pytest.raises(subprocess.TimeoutExpired):
        bash(f"(sleep 0.8; touch {marker})& echo launched; sleep 5", timeout=0.2)
    time.sleep(1.0)
    assert not os.path.exists(marker), "timeout left a grandchild process running"
