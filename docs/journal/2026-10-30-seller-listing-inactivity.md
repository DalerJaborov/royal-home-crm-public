# Seller listing activity

A seller with a working listing could age into COLD/ARCHIVED after 7/60 days without contact. Adding a listing after an earlier INACTIVE decision also left the seller inactive. Both happened because the automatic status collector ignored listings and listing creation did not refresh the seller.

Working listings now protect the seller from contact-based aging. Listing creation, restoration and relevant updates refresh the seller through one hook. Nonterminal inactive sellers return to ACTIVE with cleared traffic-light fields and an audit event; completed assignments and terminal decisions are preserved. The update compares the original owner, kind and lifecycle snapshot. Listing presence is rechecked in the transaction, including both automatic deactivation paths. Live invalidation follows the committed change.

Regression coverage includes 30/60/90-day waiting, listing creation through HTTP, deleted listings, terminal states, idempotent refresh and a listing appearing between fact collection and the status update. Local tests are separate from the required full cloud suite and production verification. No production data correction is included in this change.
