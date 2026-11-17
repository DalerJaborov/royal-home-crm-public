import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A SWITCH THE CODE READS MUST REACH THE CONTAINER (review #223 H3, 17.11.2026).
 *
 * docker-compose.prod.yml passes an EXPLICIT environment list (anchor `crm-env`, no env_file): a value written into
 * .env.production that is not on that list never reaches the api/worker container. That is how CUSTOMER_AGENT_CHANNEL_CORE
 * would have stayed «on» in the file and off in production (and how the Somon catalog stayed empty on 11.11).
 *
 * Rule: every environment name read under apps/api/src is in the compose list, or in KNOWN_OUTSIDE below with a reason.
 * The customer-bot switches (CUSTOMER_AGENT_*, TELEGRAM_DIRECT_*) may never be on that list.
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));
const src = join(root, "apps/api/src");

/** Read from elsewhere on purpose (tests, local development). */
const KNOWN_OUTSIDE: Record<string, string> = {
  VITEST: "set by the test runner only",
  DEV_CRONS: "local development only",
  LOGIN_CODE_DEV_ECHO: "local development only",
};
/**
 * FOUND BY THIS GUARD ON 17.11.2026, NOT FIXED HERE: names the code reads but compose never passed. Each one is either a
 * default that is fine in production or a switch that silently never worked — passing it through can CHANGE production if
 * .env.production already holds a value, so each needs its own owner-visible decision. This list may only shrink.
 * Notably CUSTOMER_AGENT_MEDIA_EXECUTION_MODE and CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE (core media switches).
 */
const FROZEN_GAPS = new Set<string>([
  "API_RATE_LIMIT",
  "ASSISTANT_GEMINI_DAILY_ATTEMPTS",
  "ASSISTANT_TTS_DAILY_CHARS",
  "ASSISTANT_TTS_VOICE_ID",
  "ASSISTANT_TTS_VOICE_ID_TG",
  "BUYER_CANDIDATE_INTERNAL_LIVE",
  "BUYER_CANDIDATE_LIVE_FROM",
  "CRM_OWNER_VERIFICATION_EXECUTION_MODE",
  "CUSTOMER_AGENT_MEDIA_EXECUTION_MODE",
  "CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE",
  "DISK_CLEANUP_DRY_RUN",
  "ELEVENLABS_API_BASE",
  "ELEVENLABS_API_KEY",
  "GEMINI_EMBEDDING_MODEL",
  "GEMINI_EXTRACT_MODEL",
  "GEMINI_GREETING_VOICE",
  "GEMINI_IMAGE_MODEL",
  "GEMINI_LITE_MODEL",
  "GEMINI_LIVE_MODEL",
  "GEMINI_TRANSCRIBE_MODELS",
  "GEMINI_TTS_MODEL",
  "GEMINI_TTS_VOICE",
  "GEMINI_WHISPER_TTS_MODEL",
  "GOOGLE_BUDGET_TOKEN",
  "LIVE_VOICE_ADAPTIVE_ECHO",
  "LIVE_VOICE_BARGE_IN_HOLD_MS",
  "LIVE_VOICE_LOCAL_BARGE_IN",
  "LIVE_VOICE_SPEECH_LANGUAGE_CODE",
  "LIVE_VOICE_TEMPERATURE",
  "LIVE_VOICE_TRANSCRIBE_HINTS",
  "LIVE_VOICE_TRANSCRIBE_VOCAB",
  "LIVE_VOICE_VOICE_NAME",
  "MANUAL_DATA_CORRECTIONS_LIVE",
  "MARKET_MONITOR_INGEST",
  "META_ADS_GRAPH_VERSION",
  "META_ADS_TOKEN",
  "META_AD_ACCOUNT_ID",
  "OBJECT_INTEREST_PULLS_QUEUE_LEAD",
  "OPENAI_API_KEY",
  "PBX_TRAFFIC_LIMIT_MB",
  "PUBLICATION_METADATA_EXECUTION",
  "PUBLIC_APP_URL",
  "PUSH_QUIET_HOURS",
  "RECRUITMENT_CONTACT_DRY_RUN",
  "SELLER_CONTROL_INTERNAL_LIVE",
  "SELLER_CONTROL_LIVE_FROM",
  "SITE_PUBLIC_URL",
  "SMS_DRY_RUN",
  "TEAM_REQUESTS_TOKEN",
  "THREADS_GRAPH_BASE",
  "VIDEO_TMP_DIR",
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    if (name === "generated" || name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

export function envNamesRead(sources: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of sources) {
    for (const match of text.matchAll(/\benv(?:\.|\[["'])([A-Z][A-Z0-9_]{2,})/g)) names.add(match[1]);
  }
  return names;
}

export function composeEnvNames(compose: string): Set<string> {
  const names = new Set<string>();
  for (const line of compose.split(/\r?\n/)) {
    const match = /^\s+([A-Z][A-Z0-9_]{2,}):\s/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

describe("every environment switch the API reads reaches the production container", () => {
  const read = envNamesRead(files(src).map(path => readFileSync(path, "utf8")));
  const passed = composeEnvNames(readFileSync(join(root, "docker-compose.prod.yml"), "utf8"));

  it("customer-bot switches are all passed through compose", () => {
    const bot = [...read].filter(name => /^(CUSTOMER_AGENT_|TELEGRAM_DIRECT_)/.test(name) && !FROZEN_GAPS.has(name));
    expect(bot.length).toBeGreaterThan(5);
    expect(bot.filter(name => !passed.has(name))).toEqual([]);
  });

  it("no other name is missing except the documented and frozen ones", () => {
    const missing = [...read].filter(name => !passed.has(name) && !(name in KNOWN_OUTSIDE) && !FROZEN_GAPS.has(name)).sort();
    expect(missing).toEqual([]);
    // A frozen gap that got fixed (passed through or no longer read) must leave the list.
    expect([...FROZEN_GAPS].filter(name => passed.has(name) || !read.has(name))).toEqual([]);
  });

  it("catches the breakage it exists for", () => {
    const fake = envNamesRead(['const x = process.env.CUSTOMER_AGENT_NEW_SWITCH;', 'env["CUSTOMER_AGENT_OTHER"]']);
    const composeNames = composeEnvNames("    environment: &crm-env\n      CUSTOMER_AGENT_OTHER: \"${CUSTOMER_AGENT_OTHER:-}\"\r\n");
    expect([...fake].filter(name => !composeNames.has(name))).toEqual(["CUSTOMER_AGENT_NEW_SWITCH"]);
  });
});
