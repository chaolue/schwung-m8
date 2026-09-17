#!/bin/bash
# Run the module's test suite.
#
# Every test loads the REAL src/ui.js in Node, so this is also the only
# thing that catches the temporal-dead-zone ReferenceError that
# `node --check` cannot see - run it before every deploy, not just when a
# change looks risky. See tests/README.md.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")/tests"

fail=0
for t in test_*.mjs; do
    printf '%-24s ' "$t"
    if out=$(node "$t" 2>&1); then
        echo "$out" | tail -n 1
    else
        echo "FAILED"
        echo "$out" | sed 's/^/    /'
        fail=1
    fi
done

echo ""
if [ "$fail" = "0" ]; then echo "=== All suites passed ==="; else echo "=== FAILURES ==="; fi
exit $fail
