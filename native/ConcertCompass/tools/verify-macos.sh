#!/bin/bash
# Compile and test only. No account, signing credentials, deployment, or purchase.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Apple SDK verification requires macOS with Xcode. Portable tests: swift test."
  exit 2
fi
command -v xcodebuild >/dev/null || { echo "Select an installed Xcode first."; exit 2; }
mkdir -p qa/macos
xcodebuild -version | tee qa/macos/xcode-version.txt
python3 tools/prepare_assets.py
python3 tools/generate_xcode_project.py
swift test -c release 2>&1 | tee qa/macos/core-tests.log
plutil -lint iOS/ConcertCompass.xcodeproj/project.pbxproj iOS/ConcertCompass/Info.plist iOS/ConcertCompass/PrivacyInfo.xcprivacy
xcodebuild -project iOS/ConcertCompass.xcodeproj -scheme ConcertCompass \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build-for-testing \
  2>&1 | tee qa/macos/build.log
UDID="${SIMULATOR_UDID:-}"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); a=[v for k,vs in sorted(d["devices"].items(),reverse=True) if "iOS" in k for v in vs if v.get("isAvailable") and "iPhone" in v["name"]]; print(a[0]["udid"] if a else "")')"
fi
if [ -z "$UDID" ]; then
  echo "::error::Apple build passed but no iPhone simulator is installed. Native tests NOT RUN."
  exit 3
fi
xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$UDID" -b
RESULT="qa/macos/NativePipeline-$(date -u +%Y%m%dT%H%M%SZ).xcresult"
xcodebuild -project iOS/ConcertCompass.xcodeproj -scheme ConcertCompass \
  -configuration Debug -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath .derivedData -resultBundlePath "$RESULT" \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 \
  CODE_SIGNING_ALLOWED=NO test-without-building 2>&1 | tee qa/macos/integration-tests.log
printf '\nApple SDK build and simulator tests passed. Physical iPhone testing remains required.\n'
