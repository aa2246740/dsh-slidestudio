# Browser runtime onboarding contract

## Decision snapshot

Show renderer readiness on the Create Hub, before the composer. Reuse the host's
existing automatic managed-runtime provisioner; do not add a second installer.
The panel must not confuse configured model credentials with a working browser.
No percentage progress: downloads and system setup have no reliable total.

## Contract

- Checking/installing: polite live status, automatic polling, no duplicate install.
- Ready: compact confirmation, refresh model capability health.
- Failed/missing: plain-language limitation, diagnostic detail rendered as text,
  retry button and expandable source-checkout/offline instructions.
- Explicit runtime override: never silently replace the user's configured path.
- Retry uses the authenticated same-origin host, deduplicates concurrent requests,
  and returns immediately while provisioning continues in the background.
- Keep model setup, drafting and existing-document access available. Do not claim
  rendering or screenshot-dependent exports work without a ready browser runtime.
- Controls have oracle rows. Chinese/English follow the existing UI locale.
- No decorative animation, no motion dependency, keyboard-operable native controls.

## Verification

Unit checks cover failure detail, retry request, installing-to-ready transition,
deduplication and safe text rendering. Render the actual panel on the local Hub at
desktop and narrow widths. Offline/mocked tests are not proof of model generation.

Ultimate Design Pro is not installed in this environment; this document preserves
its decision → contract → artifact → critique → verify workflow without claiming
that the unavailable skill was executed.
