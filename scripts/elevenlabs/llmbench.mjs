import { execFileSync } from "node:child_process";
const KEY = process.env.KEY, API = "https://api.elevenlabs.io", h = { "xi-api-key": KEY, "content-type": "application/json" };
const AG = { "agent_1801m5n4vt8gf4ds1nbb2ttrj71s": "Алло, здравствуйте! Это Нигина из Royal Home. Удобно пару минут?", "agent_8601m5n6kvmmfxt94bahd5he0t8a": "Алло, здравствуйте! Это Нигина из Royal Home. Можно пару вопросов по вакансии?", "agent_4201m5n6kx76eqg8y64nzp5ks3rj": "Ассалому алейкум! Ман Манзура аз Royal Home. Ду дақиқа вақт доред?" };
const LLMS = (process.argv[2] || "gemini-2.5-flash-lite,gemini-2.5-flash,gpt-4.1-mini,claude-haiku-4-5,gemini-3.5-flash").split(",");
const out = [];
for (const llm of LLMS) {
  let ok = true;
  for (const [id, first] of Object.entries(AG)) {
    const a = await (await fetch(`${API}/v1/convai/agents/${id}`, { headers: h })).json();
    const cc = a.conversation_config; cc.agent.prompt.llm = llm; cc.agent.first_message = first; delete cc.agent.prompt.reasoning_effort;
    const r = await fetch(`${API}/v1/convai/agents/${id}`, { method: "PATCH", headers: h, body: JSON.stringify({ conversation_config: cc }) });
    if (!r.ok) { ok = false; console.log(llm, "patch", r.status, (await r.text()).slice(0, 200)); break; }
  }
  if (!ok) continue;
  const res = execFileSync("node", ["suite.mjs"], { env: { ...process.env }, encoding: "utf8", maxBuffer: 20e6 });
  const score = (res.match(/ИТОГ: (\d+)\/(\d+)/) || [])[1];
  const fails = res.split("\n").filter(l => l.startsWith("FAIL")).map(l => l.slice(5)).join(", ");
  console.log(`${llm}: ${score}/14  провалы: ${fails}`); out.push([llm, +score]);
}
console.log("ЛУЧШАЯ:", out.sort((a, b) => b[1] - a[1])[0]);
