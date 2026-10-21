# Recognize recovery delivery echoes before provider acceptance

An automated recruitment correction can return as an Instagram echo before the provider's POST response. Corrections project native history only after acceptance, so neither the remembered provider ID nor a prewritten bot message exists at that moment. The ordinary managed outbox already has durable attempt matching; recovery attempts were missing from that check.

The existing echo classifier now also reads a recent IN_FLIGHT recovery with an exact native/account/scope/peer fence, validated transport, authenticated payload and integrity hash. Accepted recoveries match their scoped provider receipt. READY, UNKNOWN, expired attempts, partial text and different employee messages do not qualify. This check creates no delivery receipt, retry or ownership grant. Accepted correction projections identify their sender as the bot.

Validation: regression first failed on early/accepted recovery echoes; targeted unit and PostgreSQL tests cover the new proof and preserve the existing ordinary outbox and manual-pause behavior. Full exact-commit release validation and independent production checks remain required.
