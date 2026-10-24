# Notifications manual read failure

NFY01, an accepted TU01 variant: show the rejected **Прочитать всё** mutation locally on desktop and mobile. Two existing MutationError renderers were added; hook silence, successful reads, automatic-read rules and API stay unchanged. Acknowledgment retains unread items; intentional retry can succeed normally.

Durable actual Notifications/hooks/production queryClient/Toasts, synthetic AGENT transport, Chrome1440/390: unchanged-source2RED+6controls, then identical8PASS. The two manual cases each include a retry assertion; these remain eight cases, not ten. Cases include pending disable, error visibility, acknowledgment without request/state loss, retry/refetch and empty/load/own-read controls. No production/provider/database execution. Report and raw pins: `docs/audit-20261024/FINAL-NOTIFICATIONS-ERROR.md`.

Source types/lint passed. New browser-regression typing initially failed on the fixture Window assertion; an erased unknown bridge corrected it and the explicit project passed. Retained emitted-JS comparison proves no executable test-body change, so the browser group was not repeated for that annotation.
