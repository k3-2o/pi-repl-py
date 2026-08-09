function_description = """write(path, content) — Write a file wholesale (create, or full replace); the file
is real on disk and visible to the host and all other processes.
Instead of: open(path, 'w').write(content). Use edit() for a surgical change inside a file."""


def write(path, content):
    """Write a file wholesale, creating it if missing or replacing its contents.

    Argument notes:
      content - string (or anything stringifiable) to write in full.

    Behaviour:
      - Unconditional: overwrites whatever is there. There is no size cap.
      - Use edit() for a targeted change inside an existing file; write() is for
        a new file or a full rewrite.

    Environment:
      This evaluator runs in a project-local Python venv, not the system
      interpreter. For a package install that is ~/.pi/agent/pi-repl/venv; for a
      repo checkout it is .venv/. Files you write are real files on disk in the
      working directory, visible to the host and other processes.
    """
    with open(path, "w", encoding="utf-8") as f:
        f.write(content if isinstance(content, str) else str(content))
    return f"wrote {path} ({len(str(content))} chars)"