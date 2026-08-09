function_description = """edit(path, old_text, new_text) — One exact, unique replacement in a file.
Instead of: content.replace(old, new) — which silently replaces every occurrence. edit() fails loudly
unless old_text matches exactly once, and leaves the file untouched on error; if it errors, re-read
the file and retry."""


def edit(path, old_text, new_text):
    """Perform a targeted single replacement in a file.

    Argument notes:
      old_text - exact, unique text already in the file to replace.
      new_text - text to substitute for it.

    Behaviour:
      - Requires old_text to appear EXACTLY once in the file. Zero or multiple
        matches raise an error instead of guessing, so it can never silently
        mangle a file it wasn't sure about.
      - If it fails, the file is left untouched.

    Environment:
      This evaluator runs in a project-local Python venv, not the system
      interpreter. For a package install that is ~/.pi/agent/pi-repl/venv; for a
      repo checkout it is .venv/. The file edited is a real file on disk.
    """
    with open(path, encoding="utf-8") as f:
        content = f.read()
    count = content.count(old_text)
    if count == 0:
        raise ValueError(
            f"edit: could not find the given old_text in {path} — it may have already been "
            "applied or the file changed. Re-read the file and retry."
        )
    if count > 1:
        raise ValueError(
            f"edit: old_text occurs {count} times in {path} — make it more specific so it matches exactly once."
        )
    content = content.replace(old_text, new_text, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return f"edited {path}"