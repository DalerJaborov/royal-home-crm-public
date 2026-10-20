# Public migration ancestry guard

The old private source history must never enter the cleaned public repository. A push of an old feature branch, including a merge with a clean public branch, can otherwise publish the old parents.

The pre-push hook checks every non-deletion ref sent to the public CRM and requires exactly its initial clean root. Both cloud workflows independently check the checkout ancestry. Local private test remotes retain the existing release-hook behavior. Regression tests cover private branches, mixed ancestry, missing roots, HTTPS/SSH targets and direct invocation before network access.

Active source changes were ported as reviewed diffs. Their original branches, unfinished files and previews remain in private recovery folders. Migration does not imply feature deployment; actual production state is checked separately.
