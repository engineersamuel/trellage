#!/usr/bin/env bash

sandbox_fixture_home_volume=
sandbox_fixture_home_mount=
sandbox_fixture_home_owner=

sandbox_fixture_home_create() {
  local image="${1-}" fixture="${2-}"
  if [[ "$#" -ne 2 || -z "$image" || ! "$fixture" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    printf 'sandbox entry fixture: expected IMAGE and a safe fixture name\n' >&2
    return 1
  fi
  if [[ -n "$sandbox_fixture_home_volume" ]]; then
    printf 'sandbox entry fixture: a home volume already exists\n' >&2
    return 1
  fi

  # Desktop bind mounts can report changing inodes for unchanged directories.
  # Keep runtime state on Linux storage so identity and permission checks are real.
  sandbox_fixture_home_owner="$fixture-$$-$RANDOM-$RANDOM"
  sandbox_fixture_home_volume="$(docker volume create \
    --label "trellage.fixture=$fixture" \
    --label "trellage.fixture.owner=$sandbox_fixture_home_owner")" || return
  if [[ ! "$sandbox_fixture_home_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    printf 'sandbox entry fixture: Docker returned an invalid home volume name\n' >&2
    return 1
  fi
  sandbox_fixture_home_mount="type=volume,src=$sandbox_fixture_home_volume,dst=/home/agent,volume-nocopy"
  docker run --rm --network none --read-only --user '0:0' \
    --entrypoint /bin/bash \
    --mount "$sandbox_fixture_home_mount" \
    "$image" -ceu 'chown 10001:10001 /home/agent; chmod 0700 /home/agent' \
    || {
      printf 'sandbox entry fixture: could not initialize home volume %s\n' \
        "$sandbox_fixture_home_volume" >&2
      return 1
    }
}

sandbox_fixture_home_cleanup() {
  local owner
  [[ -n "$sandbox_fixture_home_volume" ]] || return 0
  if [[ ! "$sandbox_fixture_home_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    printf 'sandbox entry fixture: refusing cleanup of an invalid volume name\n' >&2
    return 1
  fi
  owner="$(docker volume inspect \
    --format '{{ index .Labels "trellage.fixture.owner" }}' \
    "$sandbox_fixture_home_volume")" || return
  if [[ -z "$sandbox_fixture_home_owner" || "$owner" != "$sandbox_fixture_home_owner" ]]; then
    printf 'sandbox entry fixture: refusing cleanup of an unowned volume: %s\n' \
      "$sandbox_fixture_home_volume" >&2
    return 1
  fi
  if ! docker volume rm "$sandbox_fixture_home_volume" >/dev/null; then
    printf 'sandbox entry fixture: could not remove home volume: %s\n' \
      "$sandbox_fixture_home_volume" >&2
    return 1
  fi
  sandbox_fixture_home_volume=
  sandbox_fixture_home_mount=
  sandbox_fixture_home_owner=
}
