# Search for approved company rules

The pilot covers four reviewed Russian and Tajik rules on editor handoff, publication, price changes, and showings. Telegram groups resolve these rules locally. Private Telegram and CRM turns may rank the reviewed vectors and check that the strongest match agrees with the detected topic. The Gemini request contains only a fixed bilingual phrase chosen in code. The provider receives neither the incoming message nor CRM records, contacts, call transcripts, staff conversations, or group history. An operational question about the current price, editor, or publication stays on the live CRM path.

## Activate the pilot

1. Release normally through `npm run ship` and confirm the production API and worker run the same released revision. Both Compose switches default to false.
2. From the released server checkout, use the read-only check below. It prints only counts and switch states. Expect `approved: 4` and `ready: 4`. If approval is incomplete, reconcile against the reviewed pilot before activating. If vectors are already ready, skip indexing.
3. If approved vectors are missing, set `ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED=true` in the managed production environment while leaving lookup off. Apply via the normal API and worker rollout. An active CRM administrator or director can ask the assistant to prepare the shared-rule index, review the proposed titles and revisions, and confirm. Only exact reviewed title, content, source, and revision are eligible for Google document embeddings. Recheck readiness. If a batch partially fails, retry with another explicit preview and confirmation.
4. Keep indexing off during normal use. Set `ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED=true` and apply via the same rollout. Check both services and repeat the readiness command. Test a general rule in each language in private, a group rule via local lookup, and a specific object status via CRM.
5. To roll back, set both switches to false and roll out again. Local lookup still works for active reviewed rules. This requires no changes to saved rules or vectors.

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml \
  exec -T worker node --input-type=module < ops/assistant-knowledge-pilot-check.mjs
```

## Version, costs and fallback

Only the active, unexpired reviewed revision is eligible. The vector must match the configured model and dimension, contain finite numbers, and have nonzero length. A private query makes at most one budgeted provider request and accepts a cosine score of at least 0.65. A fresh local lookup supplies the reviewed rule if the vector is absent, the score is low, the two lookups disagree, or the provider times out or fails. A changed or archived rule is excluded from automatic lookup until reviewed. Manual keyword search for other shared knowledge continues under its existing access rules.

The configured provider limit for lookup is 2.5 seconds. Saving a rule does not schedule any indexing. Indexing sends at most one budgeted attempt per confirmed eligible record. If the model or dimension changes, reindex the reviewed records before enabling lookup.
