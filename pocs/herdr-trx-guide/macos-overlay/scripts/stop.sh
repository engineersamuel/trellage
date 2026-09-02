#!/bin/bash
set -euo pipefail

LABEL="dev.trellage.trx-guide-overlay"
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID/$LABEL"
fi
