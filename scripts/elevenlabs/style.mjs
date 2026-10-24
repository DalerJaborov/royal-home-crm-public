const h = { "xi-api-key": process.env.KEY, "content-type": "application/json" }, API = "https://api.elevenlabs.io";
for (const id of ["agent_1801m5n4vt8gf4ds1nbb2ttrj71s", "agent_8601m5n6kvmmfxt94bahd5he0t8a", "agent_4201m5n6kx76eqg8y64nzp5ks3rj"]) {
  const a = await (await fetch(`${API}/v1/convai/agents/${id}`, { headers: h })).json(); const cc = a.conversation_config;
  cc.tts.expressive_mode = false; cc.tts.speed = 1.15; cc.tts.stability = 0.45;
  cc.turn.soft_timeout_config = { ...cc.turn.soft_timeout_config, timeout_seconds: -1, additional_soft_timeout_messages: [], randomize_fillers: false };
  cc.agent.prompt.prompt = cc.agent.prompt.prompt.replace(/Начинай ответ с короткой реакции: «Ага», «Понимаю», «Конечно», «Отлично»\./, "Реакцию «Ага/Понимаю» ставь не чаще раза в три реплики, не нанизывай их. Без «Мм», «Так».").replace(/Бо реаксияи кӯтоҳ сар кун: «Ҳа», «Фаҳмидам», «Албатта»\./, "Реаксияи кӯтоҳро кам истифода бар.");
  const r = await fetch(`${API}/v1/convai/agents/${id}`, { method: "PATCH", headers: h, body: JSON.stringify({ conversation_config: cc }) });
  const b = (await (await fetch(`${API}/v1/convai/agents/${id}`, { headers: h })).json()).conversation_config;
  console.log(id.slice(0, 14), r.status, "expr", b.tts.expressive_mode, "speed", b.tts.speed, "filler", b.turn.soft_timeout_config.timeout_seconds);
}
