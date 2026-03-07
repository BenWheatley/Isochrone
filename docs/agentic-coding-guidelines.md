# Agentic Coding Guidelines

## Purpose
Provide deterministic workflows so human and AI contributors can work safely and quickly.

## Required loop
1. Understand and restate scope.
2. Write failing tests.
3. Implement the smallest passing change.
4. Run `make check`.
5. Run `make review` and self-review the full diff before commit.
6. Document notable behavior/contract updates.

## Quality gates
- Python: ruff, mypy, pytest
- Web runtime: direct browser smoke-check via static server (no Node.js toolchain)
- CI runs Python gates on pull requests and pushes to `main`

## Change hygiene
- Avoid unrelated modifications.
- Remove dead code in touched files.
- Keep PRs small enough for fast review.
