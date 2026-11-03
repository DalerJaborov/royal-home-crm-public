# Shared knowledge semantic search

Implemented in source; disabled by default. No live provider or production migration was run during implementation.

## Activation and costs

- Apply the additive `20261103160000_assistant_knowledge_embeddings` migration through the normal reviewed release process.
- `ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED=true` enables the feature. No environment file was changed.
- An employee explicitly requests `index_company_knowledge` and confirms the preview. Each approved batch contains at most ten specific knowledge IDs and revisions. Each record causes at most one embedding request; a later batch needs another explicit request and confirmation.
- Saving knowledge never indexes it automatically. Searching never embeds the company corpus. A search makes at most one query embedding, and makes none when the index is empty or exceeds its scan bound.
- Every actual embedding fetch requires the injected monetary reservation hook. Retries are limited to one attempt for this feature. The root integration shares the query embedding wallet with the assistant turn; confirmed indexing has its own bounded action wallet and uses the same global daily counter.

## Consistency and scope

All employees search the same approved company knowledge. This is a search index, not model training. Original records, sources, versions, expiry and archive remain authoritative.

Vectors are accepted only at the configured dimension with finite, nonzero components. Indexed rows must match the current record revision, model and dimension. Changes made while an embedding request is in flight prevent the old result from becoming searchable. Retrieval rechecks revision, archive and expiry after the external request, including the keyword fallback after a provider failure.

The keyword search remains available while the feature is disabled or a provider fails. Semantic and keyword results are merged with reciprocal rank, limited to six records. A partial indexing batch can leave successfully indexed earlier records when a later provider request fails; re-requesting a batch starts from the remaining pending records.

## Deliberate limitations

- At most 256 current eligible indexed records are scanned. A larger index falls back to keyword search rather than silently searching only part of the company corpus. A database vector index or explicit partitions are needed before scaling this limit.
- The cosine threshold of 0.65 is a starting heuristic. Russian/Tajik retrieval quality has not been measured with live embeddings or approved company examples.
- Changing model or dimensions makes previous vectors ineligible and requires explicitly confirmed reindexing.
- Indexing does not verify facts, resolve contradictory records or automatically ingest staff conversations. Sources remain employee-provided claims.
- The embedding migration and concurrency tests were exercised only against the explicitly guarded disposable PostgreSQL test database. Offline mocks verify provider boundaries; they do not prove live provider quality.
