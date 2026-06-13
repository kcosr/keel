# Review Workload Fixture

Large fan-out review workload used to stress Keel's durable execution model.

- `review.workflow.ts` defines a 20-finder / 90-verifier / 1-synthesizer review
  shape using Keel's `ctx` API.
- `review.test.ts` runs the full 111-agent shape on the deterministic mock
  provider and verifies crash-resume and invalidation behavior.
- `live.test.ts` keeps a budget-scaled live-provider rehearsal behind
  `KEEL_LIVE=1`.
- `sample-target/` is the small local target used by the live rehearsal.

Keep this fixture focused on Keel behavior. Do not add historical provider run
artifacts here.
