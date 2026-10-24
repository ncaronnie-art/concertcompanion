#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift test --package-path native/ConcertCompass -c release -j 2
swift build --package-path devtest -c release -j 2
python3 -m unittest discover -s devtest/tests -v
printf '0.3.0\n' > devtest/.build/quality-verified
