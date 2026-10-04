# Dashboard browser regressions

Run `npm run test:browser` with Microsoft Edge installed (the default channel), or set
`PLAYWRIGHT_CHANNEL=chrome` for installed Chrome. For Playwright Chromium, set the variable
to `chromium` after installing its browser with `npx playwright install chromium`.

The harness serves only on `127.0.0.1:4173`. It bundles the real dashboard, drawer, editors,
history and application CSS; only Next Link and dynamic loading are adapted to run without
the server framework. Every project, person and action is fictional and in memory. It does
not load `.env`, authenticate, connect to a database, or call production APIs.

Coverage includes repeated/rapid switches, late history results, close/reopen, sorting and
filtering with a panel open, resizing, keyboard focus for all field types and validation,
and screenshot pixel contrast with glass and solid surfaces. The composited contrast
attachment and dashboard screenshots appear under `test-results/`.
The heartbeat tests also cover scroll anchoring, tile color/timing synchronization, tile visibility changes,
responsive widths through 390px, reduced motion, and unchanged label pixels at pulse peak.

This verifies rendered client behavior. It does not replace authenticated end-to-end QA of
server actions or production data access.

Heartbeat correction coverage: drawing-head endpoints through P/QRS/T phases, no future or translated waveform, real background pixel changes with unchanged borders, reduced motion, scroll anchoring, responsive layouts and readable label contrast.
Refinement timing: 4000ms sweep, 720-unit beat spacing across a 1440-unit strip (2000ms between beats), 360-unit/1000ms fading trail. The P-through-T drawing spans about 361ms and QRS about 67ms.
