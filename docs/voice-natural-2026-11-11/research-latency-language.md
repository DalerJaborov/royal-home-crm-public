# ElevenLabs Agents по SIP: задержка и переключение ru/tg (исследование на 11.11.2026)

Метки: ФАКТ (ссылка) = прямо написано в первоисточнике; ОЦЕНКА = мой вывод; НЕТ ДАННЫХ = не нашёл.
Ничего не запускал и не покупал: только чтение документации (elevenlabs.io/docs, changelog, блог, типы SDK на jsDelivr).
Оговорка: страницы читал через пересказчик-модель, цифры из таблиц стоит глазами сверить перед боевым решением. Платных вызовов не делал.

Базовые ссылки (префикс D = https://elevenlabs.io/docs):
- D/eleven-agents/customization/conversation-flow.md, D/eleven-agents/customization/realtime-models.md
- D/eleven-agents/customization/voice/customization/language.md, D/eleven-agents/customization/tools/system-tools/language-detection.md
- D/eleven-agents/phone-numbers/sip-trunking.md, D/eleven-agents/phone-numbers/sip-reference.md
- D/eleven-agents/customization/llm.md, D/eleven-agents/customization/llm/llm-cascading.md
- D/overview/models.md, D/changelog, API: D/eleven-agents/api-reference/agents/create.md
- Блог: elevenlabs.io/blog/voice-agent-latency-optimization, elevenlabs.io/blog/scribe-v3, elevenlabs.io/blog/realtime

## 0. Главное за 10 строк

1. Flash v2.5 (рекомендуемый ElevenLabs «самый быстрый») НЕ знает таджикский. Таджикский есть у v3, v3 Conversational (~165 мс), v4 и v4 Turbo (~100 мс). ФАКТ (D/overview/models.md). Для tg-ветки реальный выбор: v4 Turbo.
2. Scribe v3 Live (STT для живого звонка) вышел 10.11.2026, в блоге сказано «available today in ElevenAgents», есть режим multilang (смена языка посреди фразы). ФАКТ (elevenlabs.io/blog/scribe-v3). Но в типах API (SDK 2.71.0) `asr.provider` пока: `elevenlabs`(устарел) / `scribe_realtime` (по умолчанию) / `scribe_v2_turbo`. Есть ли v3 Live в вашем кабинете и поддерживает ли таджикский в realtime, НЕТ ДАННЫХ. Проверить в кабинете.
3. Таджикский в Scribe v2: уровень «Good» (WER >10 до 20 %), русский «Excellent» (<=5 %). ФАКТ (D/overview/capabilities/speech-to-text.md). Значит tg-распознавание — главный источник ошибок и лишних повторов.
4. Распознавание привязано к языку агента: `agent.language` «used for ASR and TTS». ФАКТ (create.md). Клиент заговорил на другом языке — транскрипт будет мусорный, пока инструмент language_detection не переключит язык. Документация противоречит себе: страница language.md пишет «язык фиксирован на звонок», страница language-detection.md описывает переключение голоса и ответов. ФАКТ (обе). Вывод: переключение на лету есть, но реакция запоздалая; нужна проверка живым звонком.
5. SIP-сигнализация по UDP у ElevenLabs «experimental, only for testing». ФАКТ (sip-trunking.md). Наш тест 24.10 шёл по UDP 5070. Для боя: TCP 5060 или TLS 5061 (RTP-звук остаётся UDP).
6. Самые большие потери у нас, скорее всего: (а) ожидание конца реплики (patient давал до 2,7 с), (б) время первого токена LLM (0,5-0,9 с даже у быстрых), (в) шумный tg-ASR, (г) дорога до США ~0,2 с (наш замер из памяти 24.10). Подробно в разделе 3.
7. `speculative_turn` (включить генерацию ответа ещё в паузе) есть в API с февраля 2026, по умолчанию false, может поднять расход LLM. ФАКТ (create.md, SDK TurnConfig). Лучший недорогой рычаг после выбора LLM. На телефонии не проверен: НЕТ ДАННЫХ.
8. Eleven Realtime (Mini/Max) — не наш вариант сейчас: ElevenLabs сам ведёт LLM/TTS/ASR (менять нельзя), кастомные LLM не поддерживаются, языки «90+» без упоминания ru/tg, про SIP в анонсе ничего. ФАКТ (realtime-models.md, blog/realtime). Время до первого звука у них 0,57-0,62 с (Artificial Analysis).
9. Региональные SIP (EU/IN/SG) и статические IP — только Enterprise. ФАКТ (sip-trunking.md, D/overview/administration/data-residency.md). Обычный адрес `sip.rtc.elevenlabs.io`; какой кластер отвечает, НЕТ ДАННЫХ — мерить ping/mtr с нашей станции.
10. Старые цифры из памяти устарели: gemini-2.5-flash и flash-lite депрекейтятся (снятие 30.11.2026, перевод по ступеням с 15.11), новые агенты по умолчанию на gemini-3.5-flash. ФАКТ (llm.md, changelog 02.11.2026).

## 1. Настройки: что даёт, значение, источник

### 1.1 Распознавание (ASR)

| Настройка | Что даёт | Рекомендация | Метка |
|---|---|---|---|
| `asr.provider` | Модель STT. По умолчанию `scribe_realtime`; есть `scribe_v2_turbo`; `elevenlabs` устарел | Оставить `scribe_realtime`; в кабинете посмотреть, появился ли Scribe v3 Live, и сравнить на 5-10 записях tg-реплик | ФАКТ ([create.md](https://elevenlabs.io/docs/eleven-agents/api-reference/agents/create.md)); что делает `scribe_v2_turbo` — НЕТ ДАННЫХ |
| Scribe v2 Realtime | ~150 мс до зафиксированной расшифровки (в одном анонсе 30-80 мс), 90+ языков | Базовый вариант | ФАКТ ([models.md](https://elevenlabs.io/docs/overview/models.md); [блог](https://elevenlabs.io/blog/scribe-v2-realtime-in-elevenlabs-agents)) |
| Scribe v3 Live | Точнее: на 43 % меньше смысловых ошибок и на 31 % ниже WER, чем v2 Realtime; предсказание конца реплики по контексту; режим multilang | Пробовать для обоих языков, если доступен. Таджикский в нём НЕТ ДАННЫХ | ФАКТ ([blog/scribe-v3](https://elevenlabs.io/blog/scribe-v3)) |
| Multilang-режим STT | `multilang_mode=true`: следует за сменой языка даже внутри фразы, каждый язык своим письмом. Минус: фоновая речь другого языка попадает в текст, короткие фразы чаще ошибочны. SDK пока не поддерживают, только прямой WebSocket | Через агента, скорее всего, недоступен; не планировать на него, но спросить поддержку | ФАКТ ([language-options](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/language-options)); в агентах НЕТ ДАННЫХ |
| `asr.user_input_audio_format` | `ulaw_8000` или `pcm_16000` (по умолчанию) | Для SIP оставить платформе (она сама подбирает под кодек вызова); блог советует `ulaw_8000` для телефонии | ФАКТ (create.md, [блог](https://elevenlabs.io/blog/voice-agent-latency-optimization)); поведение для SIP-входа НЕТ ДАННЫХ |
| `asr.keywords` | Подсказки слов (названия районов, ЖК, имена) повышают шанс распознавания | Заполнить 50-150 терминами на язык; для языковых пресетов нужен флаг переопределения `keywords` | ФАКТ (create.md) |
| `turn.retranscribe_on_turn_timeout` | Пересчитывает накопленный звук при таймауте, если VAD не нашёл речь (спасает тихие/шумные реплики). Эти ходы теряют скидку «тишины» в биллинге | Включить на tg-агенте при потерянных репликах | ФАКТ (create.md); эффект на tg — ОЦЕНКА |

### 1.2 Определение конца реплики и перебивания

| Настройка | Что даёт | Рекомендация | Метка |
|---|---|---|---|
| `turn.turn_eagerness` | `patient` / `normal` (по умолчанию) / `eager`. Чем выше, тем раньше агент отвечает; поддерживает «начать говорить, получив достаточно слов и запятую от LLM» | `eager` для обычного разговора (наш замер: 0,8-1,4 с ru против до 4 с на patient). Для ввода телефона/адреса переключать на `patient` через workflow | ФАКТ ([conversation-flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md); замер из памяти 24.10) |
| `turn.speculative_turn` | Запускает LLM в паузе, до полной уверенности в конце реплики | Включить и сравнить A/B (стоимость LLM выше). При неверном угадывании теряется работа LLM, не звук | ФАКТ (create.md, SDK); выигрыш в мс — ОЦЕНКА (150-400 мс) |
| `turn.turn_model` | `turn_v2` / `turn_v3` (по умолчанию v3) | Оставить v3 | ФАКТ (create.md) |
| `turn.spelling_patience` | `auto`: ждёт дольше, когда человек диктует цифры/имена; `off`: не ждёт | `auto` (нам нужны номера телефонов); при заметной паузе на обычных репликах — `off` | ФАКТ (SDK TurnConfig); влияние — ОЦЕНКА |
| `turn.turn_timeout` | Сколько ждать ответа клиента, прежде чем переспросить: 1-30 с, по умолчанию 7. Это не задержка ответа агента | 7-10 с для звонка; не путать с ожиданием конца реплики | ФАКТ (conversation-flow, create.md) |
| `turn.soft_timeout_config` | Заполнитель, если ответ долго готовится: `timeout_seconds` 0,5-8, по умолчанию -1 (выключен), рекомендуют 3; шаблон по умолчанию «Hhmmmm...yeah.», можно LLM-сообщение. Раз за ход | Держать выключенным (у нас «заполнители ВЫКЛ»); если включать, обязательно свой текст на ru и tg в `soft_timeout_translation` | ФАКТ (conversation-flow, create.md) |
| `turn.interruption_ignore_terms`, `...term_languages`, `merge_with_default_ignore_terms` | Слова, которые не перебивают агента (кивки «ага», «хорошо») | Добавить ru-кивки и tg-кивки («ҳа», «оре», «хуб», «ҳмм», «хмм») | ФАКТ (SDK TurnConfig, [changelog 17.08](https://elevenlabs.io/docs/changelog)); что есть в готовых наборах для tg — НЕТ ДАННЫХ |
| Перебивания (interruptions) | Включены по умолчанию в «Customer service»; отключать для юридических текстов | Включены. Новое в июле: бэкчаннел-детекция `ignored_as_backchannel` в транскрипте | ФАКТ (conversation-flow; changelog 13.07) |
| `turn.noisy_environment_detection` | Просит собеседника отойти, если слышен фон (Enterprise) | Не для нас (звонящие с улицы); учесть, если включено в аккаунте | ФАКТ (changelog 02.11) |
| `vad` | Конфиг VAD в API пустой | НЕТ ДАННЫХ: ручек VAD нет | ФАКТ (SDK VadConfig = {}) |

### 1.3 Генерация (LLM)

| Настройка | Что даёт | Рекомендация | Метка |
|---|---|---|---|
| Выбор модели | Доступны: Gemini 4 Argon, 3.8/3.7/3.6/3.5 Flash, 3.5 Flash-Lite, GPT-6.1/6/5.6 семейства, GPT-5.4 mini/nano, GPT-4.1/4.1 mini/4o, Claude Haiku 4.5, Sonnet 4.6/5/5.5, Opus, а также «hosted by ElevenLabs»: Qwen3.6-35B-A3B, DeepSeek Flash 4.1, GLM 5.2, Nemotron 3.5 Super VL | Брать самую быструю модель, которая проходит наши 28 сценариев: сейчас gemini-3.8-flash (25/28). Дальше мерить hosted-модели ElevenLabs (нет лишнего прыжка до внешнего API) и Haiku 4.5 | ФАКТ ([llm.md](https://elevenlabs.io/docs/eleven-agents/customization/llm.md)); скорость hosted — НЕТ ДАННЫХ |
| Фон: независимый замер голосового бенчмарка Pipecat (18.08.2026, время до первого видимого токена) | Haiku 4.5 637 мс (98 % прошли), GPT-4.1 536 мс (96,3 %), Gemini 3.6 Flash minimal 798 мс (97,1 %), 3.5 Flash minimal 892 мс, 3.5 Flash-Lite 591 мс но 68,6 % — «не подходит». Ориентир: >700 мс «слишком медленно для большинства голосовых агентов» | Согласуется с нашей картиной (flash-lite 22/28) | ФАКТ ([pipecat.ai](https://www.pipecat.ai/benchmarks/voice-readiness)), только как фон: другой стенд, без ru/tg |
| `prompt.reasoning_effort`, `thinking_budget` | Меньше размышлений = быстрее ход. Значения `none`...`max`; `thinking_budget=0` отключает | `none`/`minimal` и 0; reasoning summary выключить | ФАКТ (llm.md: «extra thinking can delay turn-taking») |
| `prompt.service_tier` | `standard` (по умолчанию) или `fast`: выше пропускная способность и ниже задержка за надбавку к цене токена, только для части моделей | Включить `fast` на нашей модели, если доступно, и сравнить: токены дёшевы, минута звонка дороже | ФАКТ (create.md, changelog 26.10); величина выигрыша — НЕТ ДАННЫХ |
| `prompt.backup_llm_config`, `cascade_timeout_seconds` | При сбое/таймауте основной модели переключается на запасные. Таймаут 2-15 с, по умолчанию 4 (был 8 до 20.07). Порядок по умолчанию: Gemini 3.5 Flash, GPT-4o, 3.5 Flash-Lite, Sonnet 4.6 | `override` со своим порядком (запас — модель, прошедшая те же сценарии, не flash-lite); таймаут 2-2,5 с, чтобы зависший ответ не стоил 4 с. Не отключать | ФАКТ ([llm-cascading](https://elevenlabs.io/docs/eleven-agents/customization/llm/llm-cascading.md)); 2-2,5 с — ОЦЕНКА |
| Размер промпта | Промпт >2000 токенов добавляет задержку; держать узкий круг задач, выносить этапы в workflow/процедуры/agent transfer | Резать промпт; знания по объектам брать инструментом, а не вклеивать | ФАКТ ([prompting-guide](https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide.md)) |
| Длина реплики | Короткие ответы («до 2-3 предложений») быстрее до первого звука и по общему времени | Прописать в промпте; для tg особенно | ФАКТ (prompting-guide) |
| Custom LLM | OpenAI-совместимый SSE; нужен function calling для system tools; можно вставить «буферную фразу» («Секунду… » с пробелом). С Realtime-моделями нельзя; при сбое custom-LLM фолбэка на модели ElevenLabs нет | Только если нужен свой хостинг ближе к ElevenLabs или своя модель; иначе лишний прыжок по сети | ФАКТ ([custom-llm](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm.md)) |
| RAG/knowledge base | Добавляет поиск на каждый ход (в стороннем обзоре ~250 мс со ссылкой на документы ElevenLabs) | Не вешать на горячий путь; цены/объекты через быстрый webhook | ОЦЕНКА (источник вторичный) |
| Инструменты (webhook) | Время ответа вашего API целиком добавляется к ходу | Укладываться в <300 мс p95; для долгих — фраза «сейчас посмотрю» и параллельный вызов | ФАКТ ([блог](https://elevenlabs.io/blog/voice-agent-latency-optimization): «have the agent speak a filler phrase»); 300 мс — ОЦЕНКА |

### 1.4 Синтез речи (TTS)

| Настройка | Что даёт | Рекомендация | Метка |
|---|---|---|---|
| `tts.model_id` | Допустимые: flash_v2, flash_v2_5, multilingual_v2, v3_conversational, v4, v4_turbo (turbo_v2/2_5 устарели). По умолчанию у новых агентов `eleven_v4_turbo` | ru: Flash v2.5 (самый быстрый, ~100 мс; блог ElevenLabs: «use Flash v2.5 in agents») или v4 Turbo. tg: v4 Turbo (~100 мс) или v3 Conversational (~165 мс); Flash v2.5 и Multilingual v2 таджикский не поддерживают | ФАКТ ([models.md](https://elevenlabs.io/docs/overview/models.md), create.md); связка «ru Flash / tg v4 Turbo» через языковые пресеты — ОЦЕНКА |
| Пара языков и модель | Добавление второго языка «переводит агента на Multilingual v2.5», английский всегда на v2 | Эта фраза в language.md устарела относительно списка моделей; смотреть реальную настройку в кабинете и явно задавать `model_id` в пресетах | ФАКТ ([language.md](https://elevenlabs.io/docs/eleven-agents/customization/voice/customization/language.md)); устарелость — ОЦЕНКА |
| `tts.expressive_mode` | Включается сам с v4 Turbo; теги `[laughs]`, `[sighs]` на 4-5 слов; новый вариант определения конца реплики по просодии Scribe v2 Realtime | Выключить (как сейчас): в таджикском качество тегов не гарантировано, лишние теги могут озвучиваться. Тестировать отдельно | ФАКТ ([expressive-mode](https://elevenlabs.io/docs/eleven-agents/customization/voice/expressive-mode.md): «varies across voices and languages»); эффект на tg — ОЦЕНКА |
| `tts.speed` | 0,7-1,2. Работает ТОЛЬКО на Flash v2/v2.5. На v3/v4/v4 Turbo недоступна | У нас записано speed 1.15: проверить, на какой модели tg-агент. Если v4-семейство, 1.15 молча не действует, темп задаёт голос и текст | ФАКТ ([speed-control](https://elevenlabs.io/docs/eleven-agents/customization/voice/speed-control.md); [conversational-voice-design](https://elevenlabs.io/docs/eleven-agents/customization/voice/best-practices/conversational-voice-design.md)) |
| `tts.stability` | 0,30-0,50 живее, но нестабильно; 0,60-0,85 ровнее. По умолчанию 0,5 | 0,5-0,6 для телефона | ФАКТ (conversational-voice-design); значение — ОЦЕНКА |
| Тип голоса | Стандартные и IVC синтезируются быстрее PVC (Professional Clone) | Клон сотрудника для tg: взять IVC для скорости, PVC только если качество не годится; для v4: `clone_strength` 0 | ФАКТ ([блог](https://elevenlabs.io/blog/voice-agent-latency-optimization); changelog 26.10) |
| `tts.optimize_streaming_latency` | Устарел, ничего не делает (с 13.07.2026) | Не использовать | ФАКТ (changelog 13.07; create.md) |
| `text_normalisation_type` | `system_prompt` (по умолчанию): LLM сам пишет числа словами, задержки нет, но может ошибиться; `elevenlabs`: нормализатор платформы после LLM, надёжнее, добавляет небольшую задержку | Оставить `system_prompt` и жёстко прописать: цены, телефоны, площади писать словами на языке ответа. Таджикскую нормализацию платформы НЕТ ДАННЫХ | ФАКТ (prompting-guide; create.md) |
| Словарь произношения | IPA/CMU работает на v4, v4 Turbo, v3, flash_v2; на остальных только alias (замена написания). IPA для не-английского: v3/v4/v4 Turbo. `enable_phoneme_tags` по умолчанию true | Для таджикских топонимов (Бухоро, Хучанд) — словарь с IPA на v4 Turbo, ударение — маркером ˈ внутри IPA | ФАКТ ([pronunciation-dictionary](https://elevenlabs.io/docs/eleven-agents/customization/voice/pronunciation-dictionary.md)); ударение «через ˈ» — ОЦЕНКА |
| Стрим и чанки | Платформа сама стримит; ElevenLabs советует отдавать TTS первый короткий фрагмент как можно раньше | Короткая первая фраза в ответе («Хорошо, …»), потом детали | ФАКТ ([блог](https://elevenlabs.io/blog/voice-agent-latency-optimization)) |

### 1.5 Языки и переключение

| Настройка | Что даёт | Рекомендация | Метка |
|---|---|---|---|
| `agent.language` + `language_presets` | Основной язык + пресеты по коду языка. В пресете можно переопределить `asr`, `turn`, `tts`, `conversation`, `agent` и перевод first_message / soft-timeout. Голос на язык назначается в пресете | Основной ru, пресет `tg` (свой голос, свой `model_id`, свой first_message, свои ключевые слова, свои слова-кивки) | ФАКТ (create.md, language.md) |
| Инструмент `language_detection` | Переключает язык ответов и голоса на язык из списка агента; срабатывает, когда клиент заговорил на другом языке или попросил сменить | Подключить. Описание задать свое: «если клиент ответил по-таджикски/по-русски два хода подряд — переключись» | ФАКТ ([language-detection](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/language-detection.md)) |
| `only_at_conversation_start` | По умолчанию false. Если true — переключение разрешено только в первые 2 реплики клиента, потом отключается (но после ранней смены остаётся на весь звонок). Защита от случайных переключений из-за фона и акцента | Для нашего сценария «клиент может переключиться посреди разговора» держать false; защищаться промптом (два хода подряд) | ФАКТ (language-detection.md); выбор — ОЦЕНКА |
| Языковой ASR | Распознавание идёт на языке агента («used for ASR and TTS») | Главная слабость переключения: после смены языка первая реплика на «чужом» языке распознаётся плохо. Проверить звонком: сколько реплик теряется до переключения | ФАКТ (create.md); масштаб потери — НЕТ ДАННЫХ |
| Мультиголос (`supported_voices`) | До 10 голосов, у каждого метка и язык; агент оборачивает текст тегами вида `<Spanish>…</Spanish>`; смена голоса добавляет минимум задержки, первое использование голоса чуть дольше | Запасной путь: один агент, два голоса (ru и tg) вместо пресетов. Метки регистрозависимы | ФАКТ ([multi-voice-support](https://elevenlabs.io/docs/eleven-agents/customization/voice/multi-voice-support.md)) |
| Два агента + роутинг на АТС | Документированный способ: разные номера на разные агенты через правила PBX | Надёжный базовый вариант: два номера/DID или меню 1/2 на Asterisk → ru-агент / tg-агент. Смена на лету через инструмент agent transfer (бесшовность и задержка передачи НЕТ ДАННЫХ) | ФАКТ (sip-trunking.md; [agent-transfer](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/agent-transfer.md)); схема — ОЦЕНКА |
| Заголовки SIP → динамические переменные | Любые `X-...` заголовки из INVITE становятся переменными `{{sip_...}}`; `X-Caller-ID` → `system__caller_id` | Передавать с Asterisk язык последнего общения клиента из CRM (`X-Lang: tg`) и выбирать язык/первую фразу по нему. Переопределение языка именно для SIP-звонка — НЕТ ДАННЫХ | ФАКТ (sip-trunking.md); применение — ОЦЕНКА |
| Список языков агента | «Все» = 31 язык; общий принцип «агент может говорить на всех языках TTS-модели»; в списке 31 таджикского явно нет, в 90+ у v4 — есть | В кабинете проверить, что `tg` вообще выбирается в Additional Languages (иначе — только через API/пресет) | ФАКТ (language.md, [help-center](https://elevenlabs.io/docs/help-center/product/eleven-agents/which-languages-can-i-use-with-eleven-agents.md)); доступность tg в выпадающем списке — НЕТ ДАННЫХ |

### 1.6 SIP-транк и сеть

| Настройка | Что даёт | Рекомендация | Метка |
|---|---|---|---|
| Транспорт | TCP 5060, TLS 5061 (TLS 1.2+, рекомендован), UDP 5060 «experimental, только для тестов» | TCP 5060 (или TLS 5061); от UDP-сигнализации уйти. RTP всё равно по UDP | ФАКТ ([sip-trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking.md), [sip-reference](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-reference.md)) |
| Кодеки | PCMU/PCMA (G.711, 8 кГц) и G.722 (16 кГц); Opus не упомянут | Предлагать `ulaw,alaw` без перекодирования. G.722 даёт пользу, только если вся цепочка до абонента широкополосная; на мобильных/ТфОП таджикских операторов, вероятно, 8 кГц — тогда G.722 только лишнее перекодирование | ФАКТ (sip-trunking.md); про операторов — ОЦЕНКА |
| Порты RTP, пропускная | UDP, обычно 10000-60000; не менее 100 кбит/с на звонок; нужны низкие задержка и джиттер; не ограничивать файрвол по статическим IP (ElevenLabs может приходить с разных адресов) | Открыть диапазон; NAT — частая причина одностороннего звука (rtp_symmetric, external_media_address) | ФАКТ (sip-trunking, sip-reference) |
| BYE | Слать на Contact из 200 OK, а не на общий адрес | Проверить в Asterisk/PJSIP | ФАКТ (sip-reference) |
| Аутентификация | Digest (рекомендуют) или ACL по IP; список разрешённых IP работает только для TCP/TLS | Digest-логин + TLS | ФАКТ (sip-trunking.md) |
| Шифрование медиа | `Disabled` / `Allowed` / `Required` (SRTP) | `Allowed` в бою, `Required` если оператор поддерживает | ФАКТ (sip-trunking.md) |
| Регионы | Стандартный адрес `sip.rtc.elevenlabs.io`; статические IP (`sip-static...`) и региональные `sip-static.rtc.<eu|in|sg>.residency...` только Enterprise; изолированные среды EU/IN/SG — Enterprise | Для нас Enterprise неоправдан ради задержки: сама ElevenLabs пишет, что резидентность создана не ради скорости | ФАКТ ([data-residency](https://elevenlabs.io/docs/overview/administration/data-residency.md)) |
| Одновременные звонки | Лимит по тарифу; при достижении входящие отклоняются, если не включена очередь (call queueing с hold-аудио, с 14.09.2026) | Включить очередь, иначе при пике клиент слышит сброс | ФАКТ (sip-trunking.md, changelog 14.09) |
| Перенос звонка | REFER; опция «молчание звонящего» при SIP REFER (с 31.08) | Для передачи менеджеру проверить с нашей АТС | ФАКТ (changelog 31.08) |
| Блок по РФ | ElevenLabs недоступен с VPS в РФ (из памяти 24.10) | Звук обязательно идёт мимо РФ: станция/сервер вне РФ | ФАКТ (наша память 24.10); в документации не упомянут |

### 1.7 Realtime-модели (для полноты)

- Eleven Realtime v1 Mini (`eleven_realtime_v1_mini`, по умолчанию, самый быстрый и дешёвый) и v1 Max: время до первого звука 0,62 и 0,57 с по Artificial Analysis; по сути каскад ASR+LLM+TTS, настроенный ElevenLabs. ФАКТ ([blog/realtime](https://elevenlabs.io/blog/realtime), [realtime-models.md](https://elevenlabs.io/docs/eleven-agents/customization/realtime-models.md)).
- Ограничения: LLM/TTS/ASR/reasoning/cascade фиксируются платформой; custom LLM и Bedrock нельзя; переводы только между Realtime-агентами; доступ раскатывается постепенно (с 02.11 «для всех» по changelog). ФАКТ.
- Язык ru/tg не подтверждён, SIP не упомянут. НЕТ ДАННЫХ.
- Вывод (ОЦЕНКА): пробовать как отдельный быстрый эксперимент на ru-агенте после основной настройки; для tg — только если пройдёт проверку по языку.

## 2. Что говорит доказательная база про «мягкое переключение языка» (вывод)

1. Платформа переключает язык инструментом `language_detection` по решению LLM, то есть после того, как LLM увидел транскрипт на другом языке. ФАКТ.
2. ASR при этом привязан к текущему языку агента. ФАКТ. Таджикский и русский пишутся кириллицей, поэтому «чужой» язык даёт правдоподобный мусор, а не пустоту — модели труднее заметить, что нужно переключиться. ОЦЕНКА.
3. Рабочая схема (ОЦЕНКА, к проверке 5-10 живыми звонками на ограниченный бюджет):
   - языковое «зерно» известно заранее (язык клиента из CRM через `X-` заголовок, либо меню 1/2 на Asterisk, либо два DID);
   - внутри звонка — `language_detection` с промптом «переключайся после двух реплик подряд на другом языке; не переключайся из-за одного слова»;
   - в пресете `tg` и `ru` — свой голос, своя модель TTS, свои `keywords`, свои слова-кивки, свой first_message;
   - в промпте: «отвечай на языке последней реплики клиента, названия и имена не переводи».
4. Бесплатно не проверить: симуляции (text_only) ASR не проверяют; живой звонок стоит кредитов (в памяти: тест ≈500 кр.; 11.11 автотесты съели 98 % лимита). Любой тест — только с «да» владельца и бюджетом.

## 3. Бюджет задержки по звеньям (от конца слов клиента до первого звука)

Ориентиры ElevenLabs (иллюстративный бюджет API-интеграции, не телефония): endpointing 120 мс, STT 60, сеть 60, LLM-первый токен 250, TTS-первый звук 110, буфер плеера 80 = ~680 мс P50 / ~1560 P95; цель «P50 <800 мс, P95 <1,5 с», выше 700 мс «неестественно», выше 1200 мс высокий процент бросивших трубку. ФАКТ ([блог](https://elevenlabs.io/blog/voice-agent-latency-optimization), [блог 2](https://elevenlabs.io/blog/how-do-you-optimize-latency-for-conversational-ai)). Про SIP/ТфОП в этих статьях цифр нет.

Наш реальный замер (из памяти 24.10): eager + flash-lite: ru 0,8-1,4 с, tg 1,0-2,3 с; patient + 2.5-flash: до 4 с (ожидание конца реплики до 2,7 с); gemini-3.8-flash: 1,3-2,2 с, из них дорога до США ~0,2 с.

Моя раскладка для нашей цепочки, мс (ОЦЕНКА; диапазоны из документов и бенчмарков выше, наши замеры, а не измерения по звеньям):

| Звено | Сейчас, примерно | Что можно получить | Комментарий |
|---|---|---|---|
| Таджикская ТфОП/мобильный участок + АТС (jitter buffer, пакетизация) | 60-150 в оба конца | 40-100 | Выключить лишние буферы и перекодирование на Asterisk |
| Дорога станция - ElevenLabs (SIP/RTP) | ~200 в оба конца (замер 24.10 до США) | 100-200 | Кластер для SIP не документирован; мерить ping/mtr до `sip.rtc.elevenlabs.io` |
| Ожидание конца реплики (endpointing + turn model) | 300-900 при eager, до 2700 при patient | 150-400 | `eager`, `turn_v3`, `speculative_turn`, не включать лишний `spelling_patience` |
| STT до финального текста | 150-300 (tg хуже) | 100-200 | Scribe v3 Live, `keywords`, ключ-слова на tg |
| LLM первый токен | 500-900 | 300-600 | Модель, `service_tier: fast`, reasoning off, короткий промпт, без RAG на горячем пути |
| TTS первый звук | 100-165 (модель), больше для PVC | ~100 | v4 Turbo / Flash v2.5, голос IVC, короткая первая фраза |
| Инструменты (webhook) | 0 на обычных ходах, секунды на ходе с запросом | <300 p95 | Параллельный вызов + «секунду…» |
| Сумма | 1,3-2,2 с (наш замер) | ~0,9-1,4 с | Ожидание после «ОЦЕНКА» |

Где вероятнее всего теряем (по убыванию, ОЦЕНКА):
1. Конец реплики + первый токен LLM: вместе 0,8-1,8 с, больше половины хода. Лечится eager + speculative_turn + быстрая LLM (проверить `fast` и hosted-модели).
2. Таджикская ветка: хуже ASR (Good против Excellent), шумно, потом переспрашивание и повтор хода; плюс TTS tg только на v3/v4-семействе (не Flash v2.5), клон-голос медленнее.
3. Запасной LLM: дефолтный порядок содержит flash-lite (68 % прохождения у Pipecat) и 4 с таймаута — при сбое основной модели качество и скорость проваливаются незаметно.
4. Сеть: UDP-сигнализация «experimental», кластер для SIP неизвестен, звук идёт через две страны; потеря пакетов ухудшит и ASR, и ощущаемую задержку.
5. Запоздалое переключение языка (см. раздел 2).

## 4. Чего не нашёл

- Публичных GitHub-issue elevenlabs/* про задержку на SIP (поиск по elevenlabs-python/js и examples дал только общие обсуждения). Фоновые отчёты о задержках на Vapi/LiveKit-форумах не относятся к ElevenLabs и в выводы не вошли, кроме общего ориентира «Asterisk+ElevenLabs ~500-800 мс — непроверенная оценка из блога DEV, не использовать как факт».
- Публичной страницы про `speculative_turn` (только API-ссылка, changelog и тип SDK).
- Список языков агента и таджикский в выпадающем списке «Additional Languages»; поддержка таджикского у Scribe v3 Live в realtime; кластер SIP; семантику `scribe_v2_turbo`; длительность agent transfer.
- Раздел «Январь-июнь 2026» changelog: страница отдалась усечённой, читал июль-ноябрь 2026 и отдельные записи (02.02.2026 про speculative_turn, 25.05 про Speech Engine).

## 5. Порядок проверок (без платных вызовов, затем с бюджетом)

Бесплатно:
1. Кабинет: какая модель TTS у tg-агента (влияет speed 1.15 и таджикская поддержка); виден ли Scribe v3 Live и `tg` в Additional Languages; тариф (Enterprise?).
2. На станции: `ping`/`mtr` до `sip.rtc.elevenlabs.io` (чистая сеть, без вызова ElevenLabs): RTT и потери.
3. Перевести транспорт на TCP 5060 в конфиге Asterisk (на тестовом транке, без звонка).
4. Через API (не платные) выставить: `turn_eagerness=eager`, `speculative_turn=true`, `backup_llm_config=override`, `cascade_timeout_seconds=2,5`, `service_tier`, `reasoning_effort=none`, `thinking_budget=0`, пресеты языков с голосами и `keywords`.
С бюджетом и «да» владельца:
5. 5-10 живых звонков на ru и tg с метрикой `convai_ttf_audio_since_silence`: A/B по `speculative_turn`, по LLM, по Scribe v3 Live.
6. 3-5 звонков со сменой языка посреди разговора: сколько реплик теряется до переключения.
