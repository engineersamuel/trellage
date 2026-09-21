#!/usr/bin/env bash
# Vendor termcn Ink components into packages/trellage-launcher/src/termcn/.
#
# termcn publishes shadcn-style source through a registry. The shadcn CLI is not
# used here: it writes "@/..." specifiers and this repository has no path
# aliases. This script fetches the same registry items and rewrites every
# specifier to a sibling relative import with an explicit file extension, which
# is the import style the rest of the workspace uses.
#
# Usage: scripts/vendor-termcn.sh <component> [<component> ...]
# Example: scripts/vendor-termcn.sh types use-theme terminal-style
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
destination="${root}/packages/trellage-launcher/src/termcn"

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/vendor-termcn.sh <component> [<component> ...]" >&2
  exit 2
fi

mkdir -p "${destination}"

for component in "$@"; do
  payload="$(curl -fsSL "https://termcn.dev/r/ink/${component}.json")"
  COMPONENT="${component}" DESTINATION="${destination}" python3 - "${payload}" <<'PYTHON'
import json
import os
import re
import sys

payload = json.loads(sys.argv[1])
destination = os.environ["DESTINATION"]
component = os.environ["COMPONENT"]

# Registry path -> vendored file name. Every vendored file is a sibling, so the
# nesting the registry expects ("lib/", "hooks/", "providers/") is flattened.
def vendored_name(registry_path: str) -> str:
    base = registry_path.rsplit("/", 1)[-1]
    if registry_path.startswith("registry/themes/"):
        return f"theme-{base}"
    return base

names = {vendored_name(entry["path"]): entry["path"] for entry in payload["files"]}

ALIASES = {
    "@/components/ui/types": "./types.ts",
    "@/hooks/use-animation": "./use-animation.ts",
    "@/hooks/use-clipboard": "./use-clipboard.ts",
    "@/hooks/use-focus": "./use-focus.ts",
    "@/hooks/use-input": "./use-input.ts",
    "@/hooks/use-interval": "./use-interval.ts",
    "@/hooks/use-motion": "./use-motion.ts",
    "@/hooks/use-notifications": "./use-notifications.ts",
    "@/hooks/use-theme": "./use-theme.ts",
    "@/hooks/use-unicode": "./use-unicode.ts",
    "@/lib/accessibility": "./accessibility.ts",
    "@/lib/interaction": "./interaction.tsx",
    "@/lib/terminal-style": "./terminal-style.ts",
    "@/lib/terminal-symbols": "./terminal-symbols.ts",
    "@/lib/terminal-text": "./terminal-text.ts",
    "@/lib/terminal-themes/default": "./theme-default.ts",
    "@/providers/motion-provider": "./motion-provider.tsx",
    "@/providers/theme-provider": "./theme-provider.tsx",
    "@/providers/unicode-provider": "./unicode-provider.tsx",
}

# Sibling component imports arrive extensionless ("./spinner"); the workspace
# requires the extension, and only a .tsx file exists for a component.
SIBLING = re.compile(r'(from\s+")\./([a-z0-9-]+)(")')


def rewrite(source: str) -> str:
    for alias, relative in ALIASES.items():
        source = source.replace(f'"{alias}"', f'"{relative}"')
    return SIBLING.sub(lambda m: f"{m.group(1)}./{m.group(2)}.tsx{m.group(3)}", source)


for entry in payload["files"]:
    name = vendored_name(entry["path"])
    target = os.path.join(destination, name)
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(rewrite(entry["content"]))
    print(f"vendored ink/{component}: {name}")
PYTHON
done
