# Read-only: public fixture label collides with the DM test oracle

Confirmed test-fixture defect, no application fix made. Source: phase2 `5616f8e3e886c500d0eeebf5edda924757620a2d`; cloud run40042873456, completed machine17. The machine artifact reports715 total/714 passed/1 failed. This completed-job diagnosis is separate from the overall full-run result.

`apps/api/tests/customer-dm-attachment-postgres.test.ts:38` rejects `/PRIVATE-OWNER|Какой объект|телефон|992|сотрудник/u`. The helper `apps/api/tests/helpers/customerCoreGoldenFixture.ts:35,219` embeds a random UUID in the intentionally public district name. The ordinary recognized-publication response includes that public name.

The parent downloaded the completed job's ordinary official logs. Phase2 ignored `reports/night-audit-20261024/batch3-machine17-job.log:3917–3936` shows the exact received text:

```
Цена объекта №46: 500 000 сомони.
Расположение: synthetic-core-companion-1683d264-9ef8-4f16-9922-ed8d817acb9a-public-district-1, Душанбе.
Что хотите узнать об этом объекте?
```

The matching992 belongs to the allowed public UUID fragment9922. This establishes a false-positive assertion, rather than a private-field leak. Both retries shared a beforeAll fixture/tag, so retrying the case did not remove the input collision. The compact API-tests JSON alone was insufficient; attribution was made only after reading this full received text.

Independent bounded reproduction used a new own `audit_dm_fixture` PostgreSQL database cloned from the own template on loopback15439. The actual unchanged helper, signed intake, context preparation, worker, outbox and synthetic fetch stub were retained. Updating only the owned public district label to `synthetic-public-district-992` reproduces the same regex failure; `synthetic-public-district-alpha` passes the unchanged assertion. Native1, **1 reproduced failure /1 control pass**; model generate/count counters remain0. No external send/model call occurred. Exact synthetic accounts, probe districts and properties were cleaned and read back as0.

Phase2 ignored evidence: `READONLY-DM-FIXTURE-TRIAGE.md`, `readonly-dm-fixture.probe.test.ts`, `readonly-dm-fixture.config.mts`, `readonly-dm-fixture-red-control.log`. Default test/helper source hashes remain unchanged: test `A36918ED4EF643A750583BF7F18A603F4D11CB05715EDE8C09379A33256ED48C`; helper `E8ADA49E853D22DC857D32FD7A0BDD14031C9212F8863E33D39145698E0975B3`.

Independent review selected plan B instead of the earlier unimplemented alphabetic-helper proposal. Awaiting parent source-reopen authorization: modify only the positive attachment test and its controls. Write an independent exact three-line oracle from known public fixture values: price500000/property.shortId, public district.name/city, and the literal clarification question. Compare full output with strict equality; do not invoke the renderer/projector to generate expected text. Preserve the complete existing negative regex on the residual after removing only the exact expected public price/location lines; no generic digit scrub. Seed an actual synthetic ownerContact and retain the existing private-address sentinel, asserting neither is present. Shared helper and application/guards stay unchanged.

Actual contract was checked at `customerPropertyFacts.ts:39` and `customerAgentRenderer.ts:208–223,492–500`. For the current AVAILABLE/RU/TJS500000 fixture it is exactly price, location, question joined by newline. Durable controls must cover public district992 and public shortId containing992, with unchanged model counters. Exact992 is safe in the new own probe DB; a default worker may already have another fixture with shortId992, so a free owned high shortId containing992 can avoid collisions without touching foreign rows or resetting sequences. This small allocation detail remains for parent approval. No default source/test/helper/dependency edits have been made.

Limit: the original global regex also falsely rejects a future allowed shortId992. Plan B accounts for the exact expected public price/location components while retaining the residual guard and forbidding all extra output through equality. It does not claim universal determinism for unrelated tests or arbitrary public numeric fields. No product-policy, browser or production changes occurred.
