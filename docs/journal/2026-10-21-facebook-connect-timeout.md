# 21.10.2026 — Facebook publication connection timeouts

- A transient connection timeout previously ended a Facebook video or Reels step immediately. Publishing now makes at most three attempts with 1s/2s backoff, only for connection-establishment or DNS failures.
- Retries keep the same request and Reels container. HTTP errors, socket resets, response timeouts and cancellation are not replayed. Redirects are refused so a failure after redirect cannot replay an already accepted POST. Existing pending-publication markers remain in place.
- The publication UI gives connection-specific guidance for network failures instead of suggesting an account or media problem.
- Regression: three new Reels tests failed before the change. After the change, 36 targeted API tests and 23 frontend tests passed. API and web builds, the secrets audit and the dependency gate passed. The additional existing Instagram-delete suite could not run locally because its shared setup needs a configured test PostgreSQL database; its 16 cases were not executed. Full cloud validation and production deployment remain separate release gates.
