# 04.11.2026 — Natural group addressing and one welcome voice

The atomic winner of an authorized `/assistant_on` registration sends a short,
fixed welcome through the existing ElevenLabs cache and budget path. Repeated or
concurrent registration does not regenerate the welcome or change its timestamp.
Global assistant OFF never synthesizes it. Missing voice/budget/provider support
leaves the greeting as text. Explicit Tajik command words select the Tajik greeting;
without that evidence the default is Russian. Neutral greetings contain no member
names, private data or claims of being a human.

Group members can address Madina/Mushovir at the start of a message with punctuation
or an unambiguous request. Incidental name references remain silent. A bare name
opens the same guarded author/chat window without calling AI. Follow-ups require
a short number/card code or an imperative with a CRM subject; ordinary chatter and
phone-length numbers do not enter the model. Windows expire, stop on the existing
stop words, and are bound to the current registration so reconnecting does not
revive an old conversation.

Automatic group speech is limited to replies to explicitly addressed native voice
messages up to sixty seconds, and only short, unstructured replies. Forwarded or
unaddressed audio, reference/card results and explicit text preferences stay text.
An explicit request for voice retains the existing opt-in behavior. Group property
card speech is sanitized at the adapter boundary as defense in depth; the existing
speech preparation already masked contacts. Private delivery, permissions, action
confirmation and callback revocation rules are preserved.

Validation: actual adapter/delivery fixtures reproduced twelve failures before the
patch; additional window fixtures reproduced phone-length and reconnect failures.
The focused adapter/callback/voice suite passes 83 tests, including registration
races, active/global guards, author/chat isolation, text fallback, language-specific
cache reuse and budget exhaustion. API build passes. No live Telegram messages,
ElevenLabs requests or production database mutations were made. Full PostgreSQL
cloud validation and actual group acceptance remain separate release checks.
