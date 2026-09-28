# gate-tail fixtures

`desktop-flow-2fail.txt` — the output of one real, hermetic run of
`scripts/desktop-flow.test.ts` (temp HOME, own `OCR_DESKTOP_SESSION`,
2026-09-27, 262.4s, 1052 stdout lines), in the exact shape the judge signs
into a verdict: stdout followed by stderr (separate buffers). Two failures
were injected into a throwaway copy of the test for the capture — the P2-090
"session chat rendered without the pane" probe (never holds → the real
`condition never held (12 probes)` detail on stderr) and the P2-338 1440x900
PNG-size check — so the fixture carries a real mid-run failure and a real
late one. Two report lines were aligned with the final report format after
the capture: the normal-end `last check:` line was dropped (it now prints
only on abnormal exits) and the P2-338 beat line no longer names the stale
`P3-462` banner (a beat without its own `phase()` banner prints no label).

`scripts/gate-feedback.test.ts` derives the pre-report ("legacy") output by
removing the report block and pins what a builder sees before/after the
relevance cut.
