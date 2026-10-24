# Native build checkpoint - 2026-10-16

Repository write access is now available. The source from the delivered native alpha has been integrated on a dedicated branch, not main. Core release tests: 45 passed, zero failures on Linux. Native code still requires the Apple SDK build and five simulator integration tests. The cloud verification workflow will provide the first Apple evidence; do not label it successful before the run actually passes.

No Apple account or signing credential is needed for simulator verification. A physical-device installation path remains unresolved; neither the source ZIP nor an unsigned simulator build is an installable iPhone app. No paid enrollment or public deployment has been authorized.
