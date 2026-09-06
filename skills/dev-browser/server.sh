#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HEADLESS=false
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --headless) HEADLESS=true ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

if [[ ! -x node_modules/.bin/tsx ]]; then
    echo "Installing dependencies..."
    npm ci
fi

echo "Starting dev-browser server..."
export HEADLESS
npm exec -- tsx scripts/start-server.ts
