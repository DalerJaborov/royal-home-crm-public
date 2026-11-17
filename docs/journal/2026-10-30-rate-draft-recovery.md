# Keep the exchange-rate draft after a failed save

Manual fault injection on the isolated QA stand showed that a rejected save cleared the typed rate. `useUpdateSettings` temporarily puts the optimistic rate in the settings cache; the form acknowledged it as server data and then treated rollback as a server refill.

The rate form now pauses server-field synchronization while its save is pending. After failure the previous confirmed server value remains the comparison baseline, so the unsaved draft survives. Successful responses still synchronize normally. Other settings and permissions are unchanged.

Regression: optimistic save followed by rollback failed before the fix; 10 currency/form-sync tests pass afterwards. Manual blocked-request repeat retained `10`, displayed the error and kept retry available. The network block was removed and the synthetic server value remained unchanged.
