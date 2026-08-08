"""write(path, content) — write content to a file, creating it.

Simple, unconditional. The user is expected to own their existing files; write
does not refuse to overwrite, to keep the helper forgiving for weak models.
"""

__all__ = ["write"]


def write(path, content):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content if isinstance(content, str) else str(content))
    return f"wrote {path} ({len(str(content))} chars)"