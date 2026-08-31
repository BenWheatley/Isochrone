#!/usr/bin/env bash
# bash, not zsh: this also runs on the Linux CI runner, which has no zsh, and
# a missing interpreter surfaces only as make exiting 2.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CRATE_DIR="${SCRIPT_DIR}/routing-kernel"
TARGET_TRIPLE="wasm32-unknown-unknown"
TARGET_DIR="${REPO_ROOT}/target"
OUTPUT_DIR="${REPO_ROOT}/web/wasm"
OUTPUT_FILE="${OUTPUT_DIR}/routing-kernel.wasm"
HOMEBREW_RUSTUP_BIN="/opt/homebrew/opt/rustup/bin"

mkdir -p "${OUTPUT_DIR}"

# Prefer rustup-managed toolchain when available (Homebrew rustup is keg-only).
if [[ -d "${HOMEBREW_RUSTUP_BIN}" ]]; then
  export PATH="${HOMEBREW_RUSTUP_BIN}:${PATH}"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found; install Rust toolchain first." >&2
  exit 1
fi

if ! command -v wasm-opt >/dev/null 2>&1; then
  echo "wasm-opt not found; install Binaryen first (e.g. 'brew install binaryen')." >&2
  exit 1
fi

if ! rustc --print target-list | grep -qx "${TARGET_TRIPLE}"; then
  echo "Rust toolchain does not list target ${TARGET_TRIPLE}." >&2
  exit 1
fi

RUSTLIB_DIR="$(rustc --print sysroot)/lib/rustlib/${TARGET_TRIPLE}/lib"
if [[ ! -d "${RUSTLIB_DIR}" ]]; then
  echo "Rust target stdlib not installed for ${TARGET_TRIPLE}." >&2
  if command -v rustup >/dev/null 2>&1; then
    echo "Install it with: rustup target add ${TARGET_TRIPLE}" >&2
  else
    echo "Install a Rust toolchain with ${TARGET_TRIPLE} support (rustup recommended)." >&2
  fi
  exit 1
fi

echo "Building routing-kernel (${TARGET_TRIPLE})..."
cargo build \
  --manifest-path "${CRATE_DIR}/Cargo.toml" \
  --target "${TARGET_TRIPLE}" \
  --release \
  --target-dir "${TARGET_DIR}"

INPUT_WASM="${TARGET_DIR}/${TARGET_TRIPLE}/release/routing_kernel.wasm"

echo "Optimizing routing-kernel.wasm with wasm-opt -O4..."
wasm-opt -O4 --all-features "${INPUT_WASM}" -o "${OUTPUT_FILE}"

echo "Wrote ${OUTPUT_FILE}"
