# Concert Compass native iPhone alpha

This is the SwiftUI / AVFoundation checkpoint, carried forward from `ConcertCompass_Native_Alpha_0.1.zip`. It is not a browser wrapper. The existing web app is untouched. Native work is isolated under this directory and the `native/ios-alpha-0.1` branch; do not merge or deploy without the owner's approval.

## Verification

The 45 portable Swift tests were rerun successfully on Linux on 2026-10-16. An Apple SDK build and the five native integration tests are the next required gate. Check the native-verification workflow's actual result, not this README, for Apple build status. Simulator success does not equal physical iPhone verification. No signed IPA, TestFlight invitation, or App Store release exists yet.

```sh
# Portable logic only, on a machine with Swift
swift test -c release

# macOS with Xcode, an iPhone simulator and FFmpeg (CI handles this)
bash tools/verify-macos.sh
```

The verification script generates synthetic H.264, silent, mixed-orientation and HEVC Main10 fixtures and the Xcode project, then builds/tests it. FFmpeg is only a fixture-generation tool, not part of the app. The generated CI icon is an alpha placeholder; the original designed icon remains in the original source ZIP. No real concert footage is committed or uploaded.

## Implemented in source

Photos selection, local project persistence, signal-based highlight ranking, bounded prompt interpretation, styles and trailer pacing, reviewed trims, reject/replace/lock/reorder, 9:16 native composition, cuts/dissolves, full rendered preview, original audio, gentle rumble filtering, experimental small-translation stabilization, Photos save and system sharing. Apple Foundation Models prompt interpretation is conditional on OS/device availability; the fallback is clearly labeled rules-based.

## Limits

No artist/song recognition, crowd-vocal separation, automatic performer tracking, polished whip/match transitions, background rendering, or Android port. Native implementation and image/audio quality must be tested, not inferred from source presence. The current cleanup is rumble reduction, not audience removal. Real iPhone HEVC/HDR/4K, iCloud, interruption, storage, camera-roll permissions and save/share tests remain required.

## Safety

No paid services, new public deployments, account enrollment, signing secrets, original-media modification, or automatic social posting. Standard GitHub-hosted macOS runners are free for this existing public repository; the workflow must refuse a private repository. Only test logs and synthetic test artifacts may be uploaded. Vercel deployments are disabled for native branches; commit messages must contain `[skip netlify]`.
