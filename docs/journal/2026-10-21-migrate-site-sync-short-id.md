# site-sync-short-id: public source migration

Site synchronization: export the CRM short identifier and prefer an explicit site property link over an unrelated number in bot input. The resynchronization CLI defaults to dry-run.

Ported the application and test diff onto the cleaned public main on 2026-10-21. Private history, operational evidence and generated previews remain in the private recovery archive. Product maps were regenerated from this public source.

Earlier private checks are historical evidence; this public branch requires its own cloud checks before release. This migration does not merge or deploy the feature.

Release review found that the website accepts `items[].shortId`, while the original CRM diff placed it inside `data`. The sender and regression tests now match the website contract for every action. Backfill success requires an acknowledgement for each object. Property URL parsing rejects lookalike domains, foreign paths, partial IDs and values outside the database integer range. Targeted tests reproduced these failures before the fixes; a complete cloud release remains required.
