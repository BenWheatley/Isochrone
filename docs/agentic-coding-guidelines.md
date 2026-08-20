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

## Talking to rate-limited public APIs

The project depends on free, shared, volunteer-run services - Overpass for OSM
extracts, and transit agencies' open-data endpoints. They shed load by design.
A script that hammers them is not just impolite; it produces failures that look
like bugs in our own code and sends the next person debugging a query that was
never wrong.

Learned the hard way on 2026-08-20: `fetch-missing-regions.sh` fired four
regions back-to-back with no pacing and no retry. Three "failed". None of them
had anything wrong with it - Overpass allows **2 concurrent slots per IP** and
had simply refused. The queries succeeded unchanged once paced.

Any script that calls one of these services must:

- **Pace itself.** Leave a gap between units of work rather than issuing
  requests as fast as they complete. Check the service's published quota where
  there is one (`https://overpass-api.de/api/status` reports slots).
- **Tell "come back later" apart from "this is broken".** Overpass returns
  `rate_limited` and `Dispatcher_Client::...::timeout` as runtime errors *in the
  response body*, under an ordinary HTTP status. Those deserve a backoff and a
  retry. A parse error, or a selector matching nothing, will fail identically
  however many times it is asked, so retrying only burns the quota - stop and
  report instead.
- **Back off progressively**, and cap the attempts.
- **Keep the failed response on disk.** `region-data.py` writes
  `*.failed-response-body.txt` and friends; that is what made the diagnosis
  above possible after the fact.
- **Report per unit, and continue.** One region being refused says nothing
  about the next.

Do not paper over the difference by retrying everything: a selector bug that
silently retries four times and then reports a timeout is strictly harder to
diagnose than one that fails immediately and says why.

## Change hygiene
- Avoid unrelated modifications.
- Remove dead code in touched files.
- Keep PRs small enough for fast review.
