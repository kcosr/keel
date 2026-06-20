#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/seed-default-profiles.sh [--dry-run] [--create|--update]

Seeds the local daemon profile catalog with Keel's default reusable agent profiles.
Requires the normal keel daemon environment plus admin authority, for example
KEEL_SOCKET/KEEL_DIR and KEEL_ADMIN_TOKEN.

Options:
  --dry-run   Print the profile JSON that would be written.
  --create    Fail if any profile already exists.
  --update    Fail if any profile does not already exist.

Environment:
  KEEL_BIN    CLI to invoke. Defaults to "keel".
EOF
}

dry_run=0
mode_arg=()

while (($# > 0)); do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    --create)
      if ((${#mode_arg[@]} > 0)); then
        echo "--create and --update are mutually exclusive" >&2
        exit 2
      fi
      mode_arg=(--create)
      ;;
    --update)
      if ((${#mode_arg[@]} > 0)); then
        echo "--create and --update are mutually exclusive" >&2
        exit 2
      fi
      mode_arg=(--update)
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

keel_bin="${KEEL_BIN:-keel}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/keel-default-profiles.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

seed_profile() {
  local name="$1"
  local provider="$2"
  local model="$3"
  local reasoning="$4"
  local file="$tmp_dir/$name.json"

  printf '{\n  "provider": "%s",\n  "model": "%s",\n  "reasoning": "%s"\n}\n' \
    "$provider" "$model" "$reasoning" >"$file"

  if ((dry_run)); then
    printf '== %s ==\n' "$name"
    cat "$file"
    return
  fi

  "$keel_bin" profiles set "$name" --file "$file" "${mode_arg[@]}"
}

seed_profile codex-default codex gpt-5.5 xhigh
seed_profile claude-default claude claude-opus-4-8 xhigh
seed_profile work-gemma-4-31b pi work-gemma-4-31b/gemma-4-31b high
seed_profile work-gpt-oss-120b pi work-gpt-oss-120b//models/gpt-oss-120b high
seed_profile work-nemotron-3-ultra pi work-nemotron-3-ultra/nemotron-3-ultra high
seed_profile work-qwen-3-6-27b pi work-qwen-3-6-27b/qwen3.6-27b high
