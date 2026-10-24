const KEY = process.env.KEY, API = "https://api.elevenlabs.io", agent = process.argv[2];
if (!process.env.TO_NUMBER) { console.error("TO_NUMBER=+992… — номер для теста (только свой)"); process.exit(1); }
const h = { "xi-api-key": KEY, "content-type": "application/json" };
const j = async (u, o = {}) => { for (let i = 0; i < 6; i++) { try { return await (await fetch(API + u, { headers: h, signal: AbortSignal.timeout(20000), ...o })).json(); } catch { await new Promise(r => setTimeout(r, 3000)); } } };
const s = await j("/v1/convai/sip-trunk/outbound-call", { method: "POST", body: JSON.stringify({ agent_id: agent, agent_phone_number_id: "phnum_2701m5n4zbxdephaspktt32h4m59", to_number: process.env.TO_NUMBER }) });
console.log("start", s?.success, s?.message);
let d; for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 5000)); d = await j(`/v1/convai/conversations/${s.conversation_id}`); if (d?.status === "done" || d?.status === "failed") break; }
console.log("status", d?.status, "dur", d?.metadata?.call_duration_secs, d?.metadata?.termination_reason);
for (const t of d?.transcript || []) { const m = t.conversation_turn_metrics?.metrics || {}; const lat = t.role === "agent" && m.convai_ttf_audio_since_silence ? ` [${m.convai_ttf_audio_since_silence.elapsed_time.toFixed(1)}с]` : ""; console.log((t.role === "agent" ? "Бот" : "Ты") + lat + ":", (t.message || "").slice(0, 200)); }
