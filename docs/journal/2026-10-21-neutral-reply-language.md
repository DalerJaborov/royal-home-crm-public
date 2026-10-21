# Retain customer language for neutral short replies

The DM adapter defaulted an unknown-language nonempty input to Russian. It only reused the verified user's previous language for an empty caption, so short answers and locations could switch a Tajik conversation to Russian.

Reuse the most recent decisive user language in the same verified inquiry when current detection is unknown or mixed. A decisive current Russian or Tajik message still takes precedence; company-side messages and another customer's history are not used.

Validation: a real PostgreSQL inbox/Core/outbox fixture first reproduced two wrong-language outputs for short follow-ups. The companion cases also cover deliberate RU/TG changes and isolation between customers. Model and provider responses are synthetic; they do not establish live model language quality. Full release verification and actual production observation remain separate.
# Explicit requested reply language

The same DM-only resolver now recognizes a direct RU/TG reply preference,
including colloquial Tajik. A Russian sentence requesting Tajik and a Tajik
sentence requesting Russian select the requested reply language. Mere language
mentions, negations, ambiguous alternatives and document descriptions do not
establish that preference. Dedicated actual PostgreSQL pipeline cases cover a
preference change and a subsequent neutral follow-up. Voice and legacy language
routing remain unchanged.
