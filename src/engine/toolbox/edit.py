"""edit(path, old_text, new_text) — targeted replacement in a file.

Fails loudly (rather than silently mangling) when the old_text cannot be found
exactly once — the same "stale anchor" guarantee as a real edit tool. This is
the one helper where forgiveness must give way to corruption-avoidance, because
a fuzzy replace on a changed file destroys content.
"""

__all__ = ["edit"]


def edit(path, old_text, new_text):
    with open(path, encoding="utf-8") as f:
        content = f.read()
    count = content.count(old_text)
    if count == 0:
        raise ValueError(
            f"edit: could not find the given old_text in {path} — "
            "it may have already been applied or the file changed. Re-read the file and retry."
        )
    if count > 1:
        raise ValueError(
            f"edit: old_text occurs {count} times in {path} — make it more specific so it matches exactly once."
        )
    content = content.replace(old_text, new_text, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return f"edited {path}"