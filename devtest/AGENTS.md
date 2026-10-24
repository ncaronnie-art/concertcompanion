# Private Linux quality test

This is a temporary test harness around the existing CompassCore Swift library, not a replacement app or production host. The owner approved no spending, has only an iPhone and a work computer that cannot install software, and wants only brief Project feedback, Login, or Test messages.

Branch: native/codespaces-quality-test, based on native/ios-alpha-0.1 at 2e681891fcb15fc5901c95a69acd249ae37f6b1c. Do not modify main, native/iOS, CompassCore, existing web-app files, old workflows, billing, permissions, or deployments. Retain vercel.json native/** deployment guard and [skip netlify] in all commits. Source commits do not authorize creating a Codespace or paid use.

Before the owner creates a Codespace, verify remaining personal-account included compute/storage and that billable overages cannot occur. Do not remove a payment method used by other products, raise a spending limit, add a card, or treat notification-only budgets as hard stops. No employer data/accounts/resources. No auto-create or keepalive workaround. Keep port 8765 private. No external model services, third-party uploads, credentials, personal footage in git, Actions, logs, or artifacts.

Tests must use generated media. The portable core, Linux renderer, Codespaces startup/authentication, real iPhone Safari upload/playback/Photos save, and native AVFoundation are separate gates. Report exactly which passed. An HTTP or desktop viewport check is not an iPhone test. A source ZIP is not a live app. If startup or port authentication fails, repair the cause; never make the port public to get past it.

No stabilization, semantic recognition, or crowd-voice separation is implemented here. Rumble filtering is not vocal isolation. User originals stay unchanged. /tmp is outside git but is not a deletion guarantee. Source copies delete after successful render; explicit deletion and 1h running-server expiry handle remaining files. The owner must delete the Codespace after testing. Stopped Codespaces still consume storage. No automatic social posting.
