"""bash(command, cwd=None) — run a shell command, return its result.

Returns a subprocess.CompletedProcess so the model can read .stdout, .stderr,
and .returncode and branch on them. This is also the escape hatch for spawning
processes — no separate subagent helper needed.
"""

__all__ = ["bash"]
import subprocess as _sp


def bash(command, cwd=None):
	return _sp.run(
		command,
		shell=True,
		capture_output=True,
		text=True,
		cwd=cwd,
		check=False,
	)