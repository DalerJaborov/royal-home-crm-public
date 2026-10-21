# Recovery echo scoped transport

The recovery enqueue path persists the full installed endpoint returned by the
conversation transport loader, including `subscriberId`. The echo reader used
the strict ordinary outbox transport schema, which rejects this additional key
and therefore misses genuine recovery echoes.

Recovery echo validation now explicitly requires the scoped subscriber and
matches it to the native recipient. Ordinary outbox validation is unchanged;
unknown fields, different accounts/scopes/recipients/channels and UNKNOWN
outcomes remain rejected. Exact accepted provider receipts have no age limit;
text-only matching remains bounded to a current in-flight attempt.

Regression coverage uses the actual installed-account loader and enqueue
serializer with a PostgreSQL record. Catalog/controller policy is synthetic;
the transaction rolls back and no external message is sent. Unit tests also
cover missing or mismatched subscriber and unexpected transport fields. This
does not change ownership, delivery permissions, retries or rollout percentage.

Validation: targeted recovery, ordinary outbox echo and delivery tests; API
build and source gates. The official complete cloud gate and independent
production checks are separate release requirements.
