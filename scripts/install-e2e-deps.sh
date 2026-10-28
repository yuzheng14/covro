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

install_with_apt_cache() {
  # Apt can also reuse matching archives after an image change or a failed
  # offline install, while still resolving current versions from the source.
  apt_config="$cache_dir/apt.conf"
  system_config=/etc/apt/apt.conf.d/99covro-e2e-cache
  trap 'sudo rm -f "$system_config"; rm -f "$apt_config"' EXIT
  printf 'Dir::Cache::archives "%s";\nAPT::Keep-Downloaded-Packages "true";\n' \
    "$cache_dir" > "$apt_config"
  sudo install -m 0644 "$apt_config" "$system_config"
  pnpm exec playwright install --with-deps --only-shell chromium
}

if [[ "$mode" == prepare ]]; then
  install_with_apt_cache
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
  echo "Cached package installation failed; resolving with apt and the restored archives."
else
  echo "No offline package set for this runner image; resolving with apt and the restored archives."
fi

install_with_apt_cache
