# Share the post-showing silence signal

The dashboard used a fixed three-day filter and looked for recent showings,
while oversight used the configured silence period and the last conducted
showing. A completed showing ten days ago appeared in oversight but was absent
from the dashboard.

Move the existing oversight selector into a shared library and reuse it in the
dashboard. Preserve the configured period, conducted-showing rules and bounded
candidate scan. Exclude archived clients. When a viewer role is supplied,
private last-contact evidence does not contribute to the dashboard count.
Keep the route re-export for existing consumers; do not introduce a library to
route import cycle. This only changes read-side signals, not client statuses.

Validation: baseline regression fails with dashboard zero versus oversight one.
Fixed regression covers configured seven/fourteen-day periods, cancelled and
private showings, archived clients and subsequent calls. Forty-one distinct
targeted tests passed across four files. API build and map checks passed.
Full cloud release validation and production verification remain separate.
