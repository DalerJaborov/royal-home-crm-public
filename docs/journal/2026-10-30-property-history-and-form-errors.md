# Manual QA: property history and district errors

On the isolated synthetic role stand, completing a deal left the linked property's History tab without any deal events. The events already existed under entityType Deal; the property query only selected Property records.

The exact property history now also includes the six deal lifecycle actions linked by meta.propertyId. Existing authorization and investigation filtering remain before pagination/count. Related deal metadata is reduced to valid stage enums; client identifiers, commission and narrative reasons are not exposed through property access. The general audit feed is unchanged. No audit rows are rewritten.

Adding an existing district returned HTTP 409 but had no visible form feedback and an uncaught mutation rejection. The district form now displays the server error and uses mutation callbacks to clear input only on success.

Validation: a real database regression failed before the history fix (expected one event, received zero), then passed with access, metadata and page/count checks. Property and investigation-route suites: 13 passing tests. District feedback: two passing rendering tests. API TypeScript build passes. Manual browser retest shows deal creation, stages and completion in object 13 history and the precise duplicate district error. All browser writes were synthetic local stand data; no calls, publishing or customer messages.

The next manual action, Download all photos (.zip), reproduced an unhandled ReadStream ENOENT which terminated the test API when a source file was absent. Photo and video archives now share streamFileArchive: preflight missing-file feedback, source error handlers, cancellation cleanup and no successful truncated response. The regression covers missing files, read failure after stat and a valid download after failures. This is a local synthetic-file failure, not evidence of a production outage.
