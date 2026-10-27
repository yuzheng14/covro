#!/usr/bin/env bash
set -euo pipefail

mode=${1:-}
if [[ "$mode" != prepare && "$mode" != install ]]; then
  echo "Usage: install-e2e-deps.sh <prepare|install>" >&2
  exit 2
fi

runner_image=${ImageVersion:?ImageVersion must identify the GitHub runner image}
cache_dir="$PWD/.local/e2e-deps/apt"
mkdir -p "$cache_dir"

if [[ "$mode" == prepare ]]; then
  # Keep the downloaded packages in the workspace so the cache action can read
  # them without archiving system directories or dpkg's installed-package state.
  apt_config="$cache_dir/apt.conf"
  system_config=/etc/apt/apt.conf.d/99covro-e2e-cache
  trap 'sudo rm -f "$system_config"; rm -f "$apt_config"' EXIT
  printf 'Dir::Cache::archives "%s";\nAPT::Keep-Downloaded-Packages "true";\n' \
    "$cache_dir" > "$apt_config"
  sudo install -m 0644 "$apt_config" "$system_config"
  pnpm exec playwright install --with-deps --only-shell chromium
  # Write this only after the complete install succeeds, including the case
  # where a future runner already provides every required system package.
  printf '%s\n' "$runner_image" > "$cache_dir/runner-image"
  exit 0
fi

if [[ "${E2E_CACHE_HIT:-}" == true && -f "$cache_dir/runner-image" && \
  "$(cat "$cache_dir/runner-image")" == "$runner_image" ]]; then
  shopt -s nullglob
  packages=("$cache_dir"/*.deb)
  # Preparation already verified this package set against the same runner
  # image. Install it directly instead of resolving against stale apt indexes.
  if [[ ${#packages[@]} -eq 0 ]] || \
    sudo dpkg --install "${packages[@]}"; then
    echo "Installed E2E system dependencies from cache (${#packages[@]} packages, no apt downloads)."
    # This also validates restored browser files and fills a missing browser.
    pnpm exec playwright install --only-shell chromium
    exit 0
  fi
  echo "Cached system packages could not be installed offline; using the Azure source."
else
  echo "No system package cache for this runner image; using the Azure source."
fi

pnpm exec playwright install --with-deps --only-shell chromium
