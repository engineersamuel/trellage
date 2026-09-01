"""Allow python -m trellage_graph to invoke the CLI."""

import sys
from .cli import main

sys.exit(main())
