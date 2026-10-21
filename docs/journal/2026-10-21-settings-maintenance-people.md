# Include People in the temporary settings confirmation pause

The owner reported that creating an employee in CRM Settings still asked for a
Telegram confirmation code despite the month-long settings pause. The People
tab uses `/api/v1/agents`, which the temporary policy had excluded. Include that
router in the existing policy so employee creation, editing, permissions and
other staff actions share the Settings behavior.

The existing fixed deadline remains 21 November 2026 at 06:30 UTC. Normal login,
active-account, ADMIN/DIRECTOR, settings.manage, individual operation permissions
and authenticator checks remain. Profile authentication and property operations
keep their confirmation requirements. Temporary access is audited separately
and does not create MFA elevation.

Regression coverage includes People routes, lookalike/query-only paths, an
actual invalid employee-create request reaching validation without a code,
ordinary-agent permission denial, no fabricated elevation, the profile guard,
and automatic restoration of the employee-create guard at the deadline.
