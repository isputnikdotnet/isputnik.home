# Archive

Plans, proposals and reviews for work that has shipped and that nothing in the code
points at any more. They are kept because the reasoning in them — what was decided,
what was rejected, and why — is worth more than the plan was. None of them describes
the app as it is now: where one disagrees with the code or with the living docs one
folder up, those win.

A shipped plan that code comments still cite stays in `docs/` instead, with a
`Status:` line at the top saying what shipped and what is still open, so those
comments keep pointing somewhere real. [`architecture.md`](../architecture.md#related-documents)
lists both kinds.

| Document | What it was | Shipped |
|---|---|---|
| [`iSputnik-Link-a-Device-Proposal.md`](iSputnik-Link-a-Device-Proposal.md) | Signing a TV or wall display in by scanning a QR code — the what and why | v3.5.0 (2026-08-14) |
| [`iSputnik-Link-a-Device-Plan.md`](iSputnik-Link-a-Device-Plan.md) | The same feature's implementation plan, stage by stage | v3.5.0 (2026-08-14) |
| [`gallery-slideshow-credits-proposal.md`](gallery-slideshow-credits-proposal.md) | Lettering, closing card with credits, and clips for the slideshow movie | v3.26.0 (2026-08-25), revised in v3.42.0 |
| [`duplicate-cleanup-plan.md`](duplicate-cleanup-plan.md) | Duplicate cleanup as one saved job, replacing two older pages; the Recycle Bin's location and clock | v3.0.0 (2026-08-06) |
| [`security-review-2026-08-17.md`](security-review-2026-08-17.md) | An API-surface and deployment security review | acted on in v3.10.0 (2026-08-17) |
| [`security-remediation-2026-08-17.md`](security-remediation-2026-08-17.md) | The plan that consolidated that review with a second audit, and its outcome | v3.10.0 (2026-08-17) |

The risks the security work accepted rather than fixed are listed in
[SECURITY.md](../../SECURITY.md#accepted-risks).
