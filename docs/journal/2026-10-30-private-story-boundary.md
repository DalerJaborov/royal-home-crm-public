# Private property publication boundary

Manual creation of an internal-only property showed public story/upload/repost actions despite the website publication control being disabled. A no-network regression then proved that card, sold, price-drop and video stories for private/deleted/missing properties reached credential loading. The fake credential loader throws; no real credentials, rendering or provider calls were used in this reproduction. Twelve regression cases failed before the fix.

Both story paths now check property privacy/existence before credentials, rendering, public files or provider calls. force cannot bypass this boundary. Public-property story behavior is retained. Frontend publication/upload/repost/group-sharing actions are withheld for offSite properties; removal of previously published posts remains available. Closed-property agent cards no longer claim they are already published and require a publication-change request.

The catalogue also labelled legacy showing bookings as card views. PropertyStats now only renders the verified conducted-showing field when supplied, instead of presenting bookings/cancellations as views. Catalogue rows without that aggregate retain their other metrics.

Validation: 12 private-boundary cases and 14 existing story publishing cases pass with mocked providers. UI regression keeps old-post removal while withholding new publication actions. Manual stand retest and normal release evidence are separate acceptance steps.
