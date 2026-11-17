# Complete replay for saved Telegram replies

Repeating a long saved answer could send a single clipped recording and
report that it had read the whole answer. Replay now shares the normal
sentence, language and clip limits. It strips links and masks contacts
before dividing the text, keeps numeric paragraphs intact, and checks
the final speech before sending.
A rejected or incomplete clip stops replay, leaving the private chat
on its existing incomplete-replay response path.

The private notice reports incomplete playback. A saved answer may have
been delivered only in voice, so the notice makes no claim about earlier text.
