# Mobile quick actions: roles and truthful destinations

Manual Royal Clean QA reproduced two classes of misleading quick actions:

- Editor shortcuts offered Clients and Sources, but their destination pages
  rejected that role. Shareholders saw object/client/showing creation shortcuts
  despite their read-only role.
- Director/admin task, weekly report and expense shortcuts actually opened
  generic oversight, reports (default month) and finance pages.

Filter shortcuts using existing permissions, property-creation rules and the
profile read-only flag. Shareholders/read-only profiles get permitted reports
and finance destinations. Marketing/editor menus no longer advertise Clients;
Sources, calls, telephony and other inquiries respect their page permissions.
Name generic destinations as navigation, without promising creation or a weekly
preset. No permission is granted, and backend authorization remains unchanged.

Validation: 22 local tests passed (14 capability/menu regressions and 8 existing
bottom-navigation tests). Manual mobile recheck confirmed that shareholders
only see Reports/Expenses and editors no longer see denied Clients/Sources.
Build, exact cloud checks and production are recorded separately in QA evidence.
