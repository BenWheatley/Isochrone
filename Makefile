VENV_DIR := .venv
VENV_BIN := $(VENV_DIR)/bin
PYTHON ?= $(VENV_BIN)/python
PIP ?= $(PYTHON) -m pip
RUFF ?= $(VENV_BIN)/ruff
MYPY ?= $(VENV_BIN)/mypy
PYTEST ?= $(VENV_BIN)/pytest
NPM ?= npm
PRE_COMMIT_HOME ?= .cache/pre-commit

.PHONY: bootstrap bootstrap-python bootstrap-js precommit-install format lint lint-js test review check build clean

bootstrap: bootstrap-python bootstrap-js

bootstrap-python:
	python3 -m venv $(VENV_DIR)
	$(PIP) install -e ".[dev]"

bootstrap-js:
	$(NPM) ci

precommit-install:
	PRE_COMMIT_HOME=$(PRE_COMMIT_HOME) $(VENV_BIN)/pre-commit install

format:
	$(RUFF) format data_pipeline

lint-js:
	$(NPM) run --silent lint:js

lint:
	$(RUFF) check data_pipeline
	$(RUFF) format --check data_pipeline
	$(MYPY) data_pipeline/src
	$(NPM) run --silent lint:js

test:
	$(PYTEST) -q

review:
	@echo "== Git status =="
	@git status --short
	@echo "== Diff summary =="
	@git diff --stat
	@echo "== Staged diff summary =="
	@git diff --cached --stat
	@echo "== Whitespace and conflict marker checks =="
	@git diff --check
	@git diff --cached --check

check: lint test

build:
	@echo "No build step: web app runs as vanilla ES modules."

clean:
	rm -rf .pytest_cache .mypy_cache .ruff_cache data_pipeline/.pytest_cache
