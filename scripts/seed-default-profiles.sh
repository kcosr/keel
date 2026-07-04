#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/seed-default-profiles.sh [--profiles|--workflows|--all] [--dry-run] [--create|--update]

Seeds the local daemon with Keel's default reusable agent profiles and saved workflows.
Requires the normal keel daemon environment plus admin authority, for example
KEEL_SOCKET/KEEL_DIR and KEEL_ADMIN_TOKEN.

Options:
  --profiles  Seed only the profile catalog.
  --workflows Seed only the saved workflow catalog.
  --all       Seed profiles and saved workflows. This is the default.
  --dry-run   Print what would be written.
  --create    Fail if a selected profile or saved workflow already exists.
  --update    Fail if a selected profile or saved workflow does not already exist.

Environment:
  KEEL_BIN    CLI to invoke. Defaults to "keel".
EOF
}

dry_run=0
seed_profiles=0
seed_workflows=0
selector_seen=0
mode=""
mode_arg=()

while (($# > 0)); do
  case "$1" in
    --profiles)
      seed_profiles=1
      selector_seen=1
      ;;
    --workflows)
      seed_workflows=1
      selector_seen=1
      ;;
    --all)
      seed_profiles=1
      seed_workflows=1
      selector_seen=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    --create)
      if ((${#mode_arg[@]} > 0)); then
        echo "--create and --update are mutually exclusive" >&2
        exit 2
      fi
      mode="create"
      mode_arg=(--create)
      ;;
    --update)
      if ((${#mode_arg[@]} > 0)); then
        echo "--create and --update are mutually exclusive" >&2
        exit 2
      fi
      mode="update"
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

if ((selector_seen == 0)); then
  seed_profiles=1
  seed_workflows=1
fi

keel_bin="${KEEL_BIN:-keel}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/keel-default-profiles.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

seed_profile() {
  local name="$1"
  local provider="$2"
  local model="$3"
  local reasoning="$4"
  shift 4
  local allow_tools=("$@")
  local file="$tmp_dir/$name.json"

  {
    printf '{\n  "provider": "%s",\n  "model": "%s",\n  "reasoning": "%s"' \
      "$provider" "$model" "$reasoning"
    if ((${#allow_tools[@]} > 0)); then
      printf ',\n  "allowTools": ['
      local sep=""
      local tool
      for tool in "${allow_tools[@]}"; do
        printf '%s"%s"' "$sep" "$tool"
        sep=", "
      done
      printf ']'
    fi
    printf '\n}\n'
  } >"$file"

  if ((dry_run)); then
    printf '== %s ==\n' "$name"
    cat "$file"
    return
  fi

  "$keel_bin" profiles set "$name" --file "$file" "${mode_arg[@]}"
}

seed_workflow() {
  local name="$1"
  local file="$2"
  local title="$3"
  local description="$4"
  shift 4
  local tags=("$@")
  local save_args=(
    workflow save "$name" "$repo_root/$file"
    --title "$title"
    --description "$description"
  )
  local tag

  for tag in "${tags[@]}"; do
    save_args+=(--tag "$tag")
  done

  if ((dry_run)); then
    printf '== %s ==\n' "$name"
    printf '%q ' "$keel_bin" "${save_args[@]}"
    printf '\n'
    return
  fi

  if [[ "$mode" == "create" ]] && "$keel_bin" workflow show "$name" --output json >/dev/null 2>&1; then
    echo "saved workflow $name already exists" >&2
    exit 1
  fi
  if [[ "$mode" == "update" ]] && ! "$keel_bin" workflow show "$name" --output json >/dev/null 2>&1; then
    echo "saved workflow $name does not exist" >&2
    exit 1
  fi

  local output status
  set +e
  output="$("$keel_bin" "${save_args[@]}" 2>&1)"
  status=$?
  set -e
  if ((status == 0)); then
    printf '%s\n' "$output"
    return
  fi
  if [[ "$output" == *"already has definition"* ]]; then
    printf '{"name":"%s","status":"unchanged"}\n' "$name"
    return
  fi
  printf '%s\n' "$output" >&2
  return "$status"
}

if ((seed_profiles)); then
  seed_profile codex-default codex gpt-5.5 xhigh
  seed_profile claude-default claude claude-opus-4-8 xhigh Bash
  seed_profile claude-fable-5 claude claude-fable-5 xhigh Bash
  seed_profile work-gemma-4-31b pi work-gemma-4-31b/gemma-4-31b high
  seed_profile work-gpt-oss-120b pi work-gpt-oss-120b//models/gpt-oss-120b high
  seed_profile work-nemotron-3-ultra pi work-nemotron-3-ultra/nemotron-3-ultra high
  seed_profile work-qwen-3-6-27b pi work-qwen-3-6-27b/qwen3.6-27b high
fi

if ((seed_workflows)); then
  seed_workflow \
    iterative-review \
    workflows/iterative-review/iterative-review.workflow.ts \
    "Iterative review" \
    "Durable read-only reviewer session for iterative human or agent follow-up. Parks for review-cycle signals until clean, stopped, or max rounds." \
    review iterative
  seed_workflow \
    implement-review-loop \
    workflows/implement-review-loop/implement-review-loop.workflow.ts \
    "Implement review loop" \
    "Autonomous direct-workspace implementation loop with a write-capable implementer, read-only reviewer, bounded rounds, and optional completion checks." \
    implement review
  seed_workflow \
    branch-worktree-implement-review \
    workflows/branch-worktree-implement-review/branch-worktree-implement-review.workflow.ts \
    "Branch worktree implement review" \
    "Autonomous implementation and review loop in a generated branch worktree, retaining or removing the workspace according to input retention." \
    implement review worktree
  seed_workflow \
    spec-review-loop \
    workflows/spec-review-loop/spec-review-loop.workflow.ts \
    "Spec review loop" \
    "Durable spec reviewer session that appends timestamped correspondence and waits for creator update signals until clean, stopped, or max reviews." \
    spec review
  seed_workflow \
    spec-author-review-loop \
    workflows/spec-author-review-loop/spec-author-review-loop.workflow.ts \
    "Spec author review loop" \
    "Autonomous spec author and correspondence reviewer loop for drafting or revising a spec until clean, blocked, or max rounds." \
    spec author review
fi
