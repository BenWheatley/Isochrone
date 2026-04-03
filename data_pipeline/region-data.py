#!/usr/bin/env python3
"""Entry point for multi-region fetch/build artifact generation."""

from __future__ import annotations

from isochrone_pipeline.region_pipeline import main

if __name__ == "__main__":
    raise SystemExit(main())
