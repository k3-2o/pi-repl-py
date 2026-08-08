"""read(path) — return the text of a file.

A weak model reaches for this instead of remembering exactly how to open and
slice a file by hand. Bounded so a huge file can't melt the transcript.
"""

__all__ = ["read"]


def read(path, max_lines=500):
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    if len(lines) > max_lines:
        tail = len(lines) - max_lines
        lines = lines[:max_lines] + [f"\n...[truncated {tail} lines]..."]
    return "".join(lines)