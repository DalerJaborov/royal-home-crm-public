# Calendar actions and exchange-rate validation

Manual QA found that SECURITY and SHAREHOLDER saw calendar mutation controls despite their viewing role. A synthetic SECURITY completion request returned 403, but the page did not render that mutation error. Calendar now removes completion, rescheduling, cancellation, scheduling and call controls for these viewing roles and personal read-only mode, in both layouts. Existing server authorization is unchanged. Completion failures remain visible on the page.

The exchange-rate input accepted zero although the server requires 5–15. Its native constraints now match that existing range; save errors remain visible beside the form. No exchange-rate policy, provider or production setting changed.

Validation: calendar tests reproduced seven failures before the fix; rate tests reproduced two failures. Twenty-three targeted tests passed afterwards, including ordinary calendar roles and mobile variants. Manual local checks confirmed SECURITY/SHAREHOLDER viewing controls, agent/director actions, and rejection of zero exchange rate. Cloud and production results are separate release evidence.
