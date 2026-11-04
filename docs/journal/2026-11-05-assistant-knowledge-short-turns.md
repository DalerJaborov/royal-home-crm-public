# Company knowledge lookup on short turns

The automatic lookup now skips turns without searchable words after the
approved policy check. Previously these turns browsed the latest entries
and added unrelated company knowledge to the prompt. Explicit lookup keeps
its empty-query catalog behavior and ordinary keywords keep the same match
and ranking. Tests cover acknowledgements in Russian and Tajik, emoji,
empty turns, a keyword lookup, and explicit catalog browsing.
