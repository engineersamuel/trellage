#!/usr/bin/env bash
set -euo pipefail

input="$(cat)"
command="$(jq -er '.tool_input.command // .command // ""' <<<"${input}")"

has_flag() {
  local arguments="$1"
  local short_name="$2"
  local long_name="$3"
  local token_boundary="(^|[[:space:];|&()'\"])"
  local token_end="([[:space:];|&()'\"]|$)"
  local short_pattern="${token_boundary}-[^-[:space:];|&()'\"]*${short_name}[^[:space:];|&()'\"]*${token_end}"
  local long_pattern="${token_boundary}--${long_name}([=[:space:];|&()'\"]|$)"

  [[ "${arguments}" =~ ${short_pattern} || "${arguments}" =~ ${long_pattern} ]]
}

is_destructive() {
  local command_text="$1"
  local command_boundary="(^|[[:space:];|&()'\"])"
  local executable_path="([^[:space:];|&()'\"]*/)?"
  local command_pattern
  local arguments

  command_pattern="${command_boundary}${executable_path}rm[[:space:]]+([^;&|()]*)"
  if [[ "${command_text}" =~ ${command_pattern} ]]; then
    arguments="${BASH_REMATCH[3]}"
    if has_flag "${arguments}" '[rR]' recursive && has_flag "${arguments}" f force; then
      return 0
    fi
  fi

  command_pattern="${command_boundary}${executable_path}git[[:space:]][^;&|()]*reset[[:space:]]+([^;&|()]*)"
  if [[ "${command_text}" =~ ${command_pattern} ]]; then
    arguments="${BASH_REMATCH[3]}"
    has_flag "${arguments}" h hard && return 0
  fi

  command_pattern="${command_boundary}${executable_path}git[[:space:]][^;&|()]*clean[[:space:]]+([^;&|()]*)"
  if [[ "${command_text}" =~ ${command_pattern} ]]; then
    arguments="${BASH_REMATCH[3]}"
    has_flag "${arguments}" f force && return 0
  fi

  command_pattern="${command_boundary}${executable_path}git[[:space:]][^;&|()]*push[[:space:]]+([^;&|()]*)"
  if [[ "${command_text}" =~ ${command_pattern} ]]; then
    arguments="${BASH_REMATCH[3]}"
    has_flag "${arguments}" f 'force(-with-lease)?' && return 0
  fi

  command_pattern="${command_boundary}${executable_path}docker[[:space:]][^;&|()]*volume[[:space:]]+rm([[:space:];|&()'\"]|$)"
  [[ "${command_text}" =~ ${command_pattern} ]]
}

normalized_command="${command#"${command%%[![:space:]]*}"}"
normalized_command="${normalized_command%"${normalized_command##*[![:space:]]}"}"

if is_destructive "${command}"; then
  jq -n --arg command "${command}" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: ("Risky shell command requires approval: " + $command)
    }
  }'
elif [[ "${normalized_command}" == "npm test" ]]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow"
    }
  }'
else
  printf '{}\n'
fi
