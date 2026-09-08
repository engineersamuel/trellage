# Nix build evaluation — declined (2026-09-08)

## Decision

We do not use Nix to build or configure profile container images. Profile images stay
on the current `mise oci build --locked` path. Revisit only on the triggers below.

## Why

Profile images are not built from Dockerfiles. `packages/trellage-cli/src/application.ts`
(`buildOci`) runs a digest-pinned builder image whose script ends in
`mise oci build --locked`, writes an OCI layout, and a digest-pinned importer copies it
into the Docker daemon. That path already provides what Nix is normally adopted for:

- Base image pinned by digest; builder and importer images pinned by digest.
- Debian closure resolved with `apt-get --simulate` and locked by name, version, sha256,
  size and URL (`debian-packages.ts`).
- Harness tools via `mise install --locked`; plugin sources pinned by git commit plus
  per-file sha256 (`lock-file.ts`).
- `SOURCE_DATE_EPOCH` taken from the lock, and the built manifest digest compared against
  `expectedDigest` with a hard failure on mismatch.

Nix would change how pins are computed, not whether they are checked. Adopting it means a
second dependency-resolution model beside `mise`, a second cache, and a second contributor
prerequisite across all profiles, with no capability the current path lacks. Nix also does
not remove the single-source-of-truth risk; it moves it from Debian mirrors to the nixpkgs
channel and `cache.nixos.org`. A hybrid split is worse rather than safer: two hash-pinning
systems whose composition (store paths, `SOURCE_DATE_EPOCH` normalisation, layer tar
ordering) must agree bit-for-bit, and that agreement is unverified.

Scope also bounds the upside. CI builds no images, so the blast radius of the build system
is local `mise run rebuild-profiles` runs. Nix would not touch the runtime conventions in
`prototypes/trellage/trellage` (container labels, volume seeding, lifecycle checks), which
is where most operational behaviour lives.

## What the evaluation did surface

Availability, not determinism, is the real gap. `debian-packages.ts` restricts package URLs
to `deb.debian.org` and `security.debian.org`. When a security-pocket `.deb` rotates out,
every hash in the lock is still correct and still unusable, so a locked profile becomes
unbuildable. The fix is to accept any host whose fetched bytes match the locked sha256 and
size, add `snapshot.debian.org` to the resolver fallback, and mirror resolved `.deb` bytes
by sha256 into the artifact store. None of that needs Nix.

## Limits of this evaluation

Cache hit rates, image size deltas, rollback cost, upgrade cadence and debugging ergonomics
were not measured. The conclusion rests on the pinning and verification the build already
performs, not on a benchmark against a working Nix implementation.

## Reopen triggers

Reopen the question if any of these is observed:

- The same commit produces different installed package versions or hashes across two builds.
- A profile rebuild changes runtime behaviour and it is found in production rather than review.
- Two or more unexplained rebuild drifts or failures in a quarter when rebuilding from
  commits older than 60 days.
- Lock coverage drops below roughly 80% of the runtime closure.

Separately, the compose experiment stack (`Dockerfile.agent`, `Dockerfile.copilot-agent`,
`Dockerfile.app`) is out of scope here. It runs unpinned `apt-get install -y` and vendor
installer scripts, so if that stack moves toward production the Nix question deserves its
own evaluation.
