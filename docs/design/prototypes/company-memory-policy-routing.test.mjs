import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { companyMemoryPolicyProjection } from "../../../apps/api/src/ai/assistant/knowledgePolicyQuery.ts";
import workflows from "../pilots/company-memory-workflows.json" with { type: "json" };

test("routes Russian and Tajik procedure questions to the same fixed topic", () => {
  const ru = companyMemoryPolicyProjection("Как отправить видео на монтаж?");
  const tg = companyMemoryPolicyProjection("Чӣ тавр наворро ба монтаж фиристем?");
  assert.equal(ru.id, "property-video-handoff");
  assert.deepEqual(ru, tg);
  assert.equal(companyMemoryPolicyProjection("Как правильно изменить цену?").id, "property-price-change");
});

test("keeps operational facts and conversations out of automatic policy retrieval", () => {
  for (const text of [
    "Сколько домов у монтажёра?",
    "Что с монтажом на этой неделе?",
    "Хона дар монтаж чанд рӯз аст?",
    "Как дела у монтажёра?",
    "Как отправить ОБ-000132 на монтаж?",
    "Как изменить цену на 810 000 сомони?",
    "Дайте правила показа для клиента на +992123456789",
    "Какие правила монтажа? Переписка:\nСотрудник: я отправил материал",
    "Правила публикации и изменения цены",
  ]) {
    assert.equal(companyMemoryPolicyProjection(text), null, text);
  }
});

test("even a matched question cannot send the sender’s extra words to embeddings", () => {
  const result = companyMemoryPolicyProjection("Какие у нас правила показа, спросил сотрудник Нур?");
  assert.equal(result.id, "property-showing");
  assert.doesNotMatch(result.providerQuery, /Нур|сотрудник|спросил/u);
  assert.ok(result.providerQuery.length <= 200);
});

test("curated rules fit the review contract and cite an exact public source range", async () => {
  assert.equal(workflows.length, 4);
  assert.equal(new Set(workflows.map(row => row.title)).size, workflows.length);
  for (const row of workflows) {
    assert.deepEqual(Object.keys(row).sort(), ["content", "source", "title", "validUntil"]);
    assert.ok(row.title.length >= 3 && row.title.length <= 100);
    assert.ok(row.content.length >= 5 && row.content.length <= 800);
    assert.match(row.content, /^Русский: .+\nТоҷикӣ: .+$/u);
    assert.ok(row.source.length <= 200);
    assert.equal(row.validUntil, null);
    const source = /^https:\/\/github\.com\/DalerJaborov\/royal-home-crm-public\/blob\/6fc21dbcc23cdb89127a1e8cb27b742c34bbd97b\/([^#]+)#L(\d+)-L(\d+)$/u.exec(row.source);
    assert.ok(source, row.source);
    const lines = (await readFile(new URL(`../../../${source[1]}`, import.meta.url), "utf8")).split(/\r?\n/u);
    assert.ok(Number(source[2]) > 0 && Number(source[3]) >= Number(source[2]) && Number(source[3]) <= lines.length, row.source);
  }
});

test("recognizes short colleague questions in both languages without a policy keyword", () => {
  for (const [id, russian, tajik] of [
    ["property-video-handoff", "Как понять, ролик ещё ждёт или монтажёр уже получил исходники?", "Чӣ хел фаҳмем, ки навор ба дасти монтажёр расид?"],
    ["property-publication", "После смены цены старый ролик сразу убираем?", "Навори нав барояд, пости пешинаро кай мегирем?"],
    ["property-price-change", "Кто подтверждает смену цены?", "Барои иваз кардани нарх чӣ даркор?"],
    ["property-showing", "Какие данные нужны, чтобы показать квартиру?", "Барои нишон додани хона чӣ даркор?"],
  ]) {
    const first = companyMemoryPolicyProjection(russian);
    assert.equal(first?.id, id, russian);
    assert.deepEqual(companyMemoryPolicyProjection(tajik), first, tajik);
  }
});

test("does not replace live price, publication, or editor status with a general rule", () => {
  for (const text of [
    "Кто подтвердил смену цены?",
    "Как понять, мой ролик ещё ждёт или монтажёр уже получил исходники?",
    "Как понять, монтажёр уже получил исходники ОБ-000132?",
    "Что стало со старым роликом после смены цены?",
    "Нархи ин объект чанд аст?",
    "Ин навор ба дасти монтажёр расид?",
    "Чӣ хел фаҳмем, ки навори 130 ба дасти монтажёр расид?",
  ]) {
    assert.equal(companyMemoryPolicyProjection(text), null, text);
  }
});
