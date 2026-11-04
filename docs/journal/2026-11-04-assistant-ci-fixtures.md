# Full-suite assistant fixtures and Telegram retry accounting

The migration candidate's full cloud API run failed in eight assistant unit
suites during the shared Prisma teardown: their partial database mocks omitted
`$disconnect`. Their assertions passed, but the ordinary `tests/setup.ts`
cleanup correctly failed. Add the lifecycle method to those explicit mocks;
retain the shared cleanup and all business assertions unchanged.

The Telegram rate-limit fixture also assumed every fetch was the document
request. `sendDocumentFile` now sends an independent `upload_document` action
first, consuming the queued mock response. Route fake responses by endpoint,
validate the action payload, and count both the document attempts and total
HTTP calls. Unconfigured requests reject rather than falling through to the
real network. This transport-only test mocks Prisma for the same shared
teardown contract. Production code and retry limits are unchanged.

Validation: reproduced the semantic suite's teardown failure with the normal
Vitest configuration (19 assertions passed, suite failed); after correction,
all nine affected files pass with that configuration (131 tests). The run uses
an unreachable test database address and does not require a database service.
API build and dependency gate passed; the final Telegram fixture recheck passed
all five tests after moving action assertions outside its best-effort catch. Full cloud
acceptance and deployment remain the release owner's responsibility.
