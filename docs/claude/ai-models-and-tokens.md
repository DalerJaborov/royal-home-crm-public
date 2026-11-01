# Экономия токенов, маршрутизация моделей Claude

> Перенесено дословно из корневого CLAUDE.md 01.11.2026 (сокращение стартового контекста). Короткая выжимка правил осталась в CLAUDE.md; здесь — полный текст.

<!-- CLAUDE.md (до 01.11.2026), строки 350–406 -->
## Token & cost economy (strict)

- **Minimal output.** Return only new/changed code. No re-dumping unchanged files, no
  restating what wasn't asked. Keep explanations short unless the user requests detail.
- **Prompt caching.** For large, stable instructions or repeated file context, place
  `cache_control: { type: "ephemeral" }` on the stable prefix (system prompt / tool defs).
  Caching is a **prefix match with a token minimum** (~2048–4096 depending on model) — it only
  saves money above that threshold; below it the marker is a no-op. Verify with
  `usage.cache_read_input_tokens`.
- Минуты GitHub Actions: правила про лимит 2000 минут и «минуты на выкат» устарели (репозиторий публичный, CI на своём раннере/GitHub-hosted Linux) — см. `history.md`, раздел «Устарело».

## AI model routing

When code calls Claude models, pick the cheapest tier that fits the request. (The standalone
example `router.js` that used to live in the repo root was removed on 28.09.2026 — it never ran:
its SDK was not a project dependency.)

| Tier | Use for | Model | Correct ID |
|---|---|---|---|
| SIMPLE | routine edits, tests, logging, formatting, classification | Haiku 4.5 | `claude-haiku-4-5` |
| MEDIUM | business logic, code, SQL, integrations | Sonnet 5 | `claude-sonnet-5` |
| COMPLEX | deep architecture, hard debugging, system design | Fable 5 | `claude-fable-5` |
| (heavy project work) | complex multi-step project tasks | Opus 4.8 | `claude-opus-4-8` |

Default to the cheapest tier that fits; escalate to expensive models only for complex
architecture or bugs unresolved on the first attempt.

### ⚠️ Model IDs — use only the current strings above

These older IDs are **retired and return HTTP 404** — never use them:

| Retired (do NOT use) | Replacement |
|---|---|
| `claude-3-5-haiku` | `claude-haiku-4-5` |
| `claude-3-5-sonnet` | `claude-sonnet-5` |
| `claude-3-opus` | `claude-opus-4-8` |
| `claude-3-7-sonnet`, `claude-4` | `claude-fable-5` |

### Model-specific API notes

- **Fable 5**: thinking is always on — do **not** send a `thinking` param (`{type:"disabled"}`
  → 400). No `temperature`/`top_p`/`budget_tokens`. Can return `stop_reason:"refusal"` — ship a
  server-side fallback (`betas:["server-side-fallback-2026-06-01"]`, `fallbacks:[{model:"claude-opus-4-8"}]`).
  Requires ≥30-day org data retention.
- **Sonnet 5 / Opus 4.8**: use `thinking:{type:"adaptive"}` + `output_config:{effort:"..."}`;
  `temperature`/`top_p` are rejected (400).
- **Haiku 4.5**: no `thinking`/`effort` params; keep requests simple and fast.
- Non-streaming: cap `max_tokens` ~16000 to avoid HTTP timeouts; stream for larger outputs.

