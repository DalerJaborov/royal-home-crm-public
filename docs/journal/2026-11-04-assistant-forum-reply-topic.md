# Telegram forum routing for assistant replies

A multipart work reply used the source message for the first part and dropped
the forum topic for the remaining parts. The group adapter now supplies the
incoming forum topic to every part. HTML, plain text, inline buttons, and
uploaded or cached voice carry the topic independently of the reply quote.

Regression coverage exercises the group adapter, explicit voice chunks, and
plain text fallback after a definite HTML parsing rejection. Verification
uses mocked Telegram delivery.
