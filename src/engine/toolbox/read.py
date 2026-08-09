function_description = """Return the text of a file, optionally a slice of its lines."""


def read(path, offset=1, limit=None):
    """Read a file's UTF-8 text and return it, optionally a slice of its lines.

    Argument notes:
      offset - 1-based first line to return (default 1).
      limit  - maximum number of lines to return (default: all of them).

    Behaviour:
      - Decoding errors are replaced instead of raising, so a binary-adjacent
        file still returns most of its text.
      - Keeps only what you ask for so a huge file can't flood context.

    Environment:
      This evaluator runs in a project-local Python venv, not the system
      interpreter. For a package install that is ~/.pi/agent/pi-repl/venv; for a
      repo checkout it is .venv/. python / pip on PATH may point elsewhere, so
      do not assume the system python is what's running.
    """
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    start = max(0, (offset or 1) - 1)
    end = None if limit is None else start + limit
    return "".join(lines[start:end])