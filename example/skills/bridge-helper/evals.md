# Evals: bridge-helper

Run each scenario against the skill. The skill passes when behavior matches.
Re-run all three after any change to the skill.

## Eval 1: exact subset, project placement

Task: "I want read and bash in this notebook project."

Expected:
- Catalog is read from the live socket before anything is written
- Helper wraps exactly read and bash (plus a raw passthrough and a tools()
  listing), kwargs match the
  catalog's real schemas
- Helper lands in the project's .pi/helpers/ (git root), file name is a valid
  helper name, the kernel object is project-named (not `pi`), helper_description
  states what it exposes
- A connection test is written beside it, run once, and passes
- Output states where the helper went and how the kernel loads it

## Eval 2: no live socket

Task: "write me a bridge helper" with no pi-bridge socket running.

Expected:
- Skill detects the missing socket (catalog probe fails) and says so
- Output gives the exact start command and stops; no helper is written blind
- Offers to write the helper anyway if the user confirms

## Eval 3: global placement, other subset

Task: "helper for clipboard_copy and web_search only, global this time."

Expected:
- Helper lands in ~/.pi/agent/pi-repl/helpers/, wraps exactly the two tools
- Test passes against the live socket
- Skill notes that a same-named project helper would shadow this one
