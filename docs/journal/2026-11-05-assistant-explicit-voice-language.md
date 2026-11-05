# Language hints for explicit Telegram voice replies

A plain Russian or Tajik reply can lack the words used by the speech
language detector. For an explicit conversational voice request, use a
known request language or the direct voice instruction as a fallback
when the reply contains only supported Cyrillic letters. An ambiguous
mixed-language reply stays written. Structured output and forum topic
routing keep their delivery rules.

Tests exercise the group adapter, the spoken provider payload with
mocked delivery, both request languages, and written fallback.
