import { describe, expect, it } from "vitest";
import {
  extractClipFacts, fileObjectNumber, scoreClipCandidates, textObjectNumbers, describeCandidate,
  type RecognitionDistrict, type RecognitionProperty,
} from "../src/lib/clipPropertyRecognition.js";

/**
 * РАСПОЗНАВАНИЕ ОБЪЕКТА ПО РОЛИКУ (21.11.2026): имя файла, подпись, расшифровка звука → до трёх
 * кандидатов с причиной. Чистая часть, без базы и без модели.
 */
const districts: RecognitionDistrict[] = [
  { id: "d-sino", name: "Сино", nameTj: "Ноҳияи Сино" },
  { id: "d-som", name: "Исмоили Сомони", nameTj: "Ноҳияи Исмоили Сомонӣ" },
  { id: "d-rud", name: "Рудаки (район)", nameTj: "Ноҳияи Рӯдакӣ" },
  { id: "d-fir", name: "Фирдавси", nameTj: "Ноҳияи Фирдавсӣ" },
];
let seq = 0;
function prop(extra: Partial<RecognitionProperty>): RecognitionProperty {
  seq++;
  return {
    id: `p${seq}`, shortId: 500 + seq, address: null, landmark: null, rooms: 2, floor: 4, areaSqm: 60, price: 400_000, currency: "TJS",
    districtId: "d-fir", updatedAt: new Date(2026, 10, seq), ...extra,
  };
}

describe("номер объекта в имени файла и тексте", () => {
  it("имя файла: номер в начале и с меткой; камера и дата — не номер; «3 комнаты» — не номер", () => {
    expect(fileObjectNumber("213.mp4")).toBe(213);
    expect(fileObjectNumber("213 Сино.mp4")).toBe(213);
    expect(fileObjectNumber("213_1из3.mov")).toBe(213);
    expect(fileObjectNumber("obj-213.mov")).toBe(213);
    expect(fileObjectNumber("ОБ-213 финал.mp4")).toBe(213);
    expect(fileObjectNumber("IMG_1234.MOV")).toBeNull();
    expect(fileObjectNumber("VID_20261121_0930.mp4")).toBeNull();
    expect(fileObjectNumber("20261121_123.mp4")).toBeNull();
    expect(fileObjectNumber("3 комнаты Сино.mp4")).toBeNull();
    expect(fileObjectNumber("85м2.mp4")).toBeNull();
  });
  it("текст: «№», «ОБ-», «объект» и голое число в начале; цена, комнаты и этаж номером не считаются", () => {
    expect(textObjectNumbers("смотрите №213 вечером")).toEqual([213]);
    expect(textObjectNumbers("объект 213 продаётся")).toEqual([213]);
    expect(textObjectNumbers("213", { leadingBare: true })).toEqual([213]);
    expect(textObjectNumbers("213 Сино", { leadingBare: true })).toEqual([213]);
    expect(textObjectNumbers("3 комнаты Сино", { leadingBare: true })).toEqual([]);
    expect(textObjectNumbers("3-комнатная Сино", { leadingBare: true })).toEqual([]);
    expect(textObjectNumbers("550 000 сомони", { leadingBare: true })).toEqual([]);
    expect(textObjectNumbers("5 этаж", { leadingBare: true })).toEqual([]);
    expect(textObjectNumbers("об 3-комнатной квартире")).toEqual([]);
  });
  it("в речи число словами: «объект двести тринадцать» → 213", () => {
    expect(textObjectNumbers("это объект двести тринадцать в Сино")).toEqual([213]);
  });
});

describe("признаки из слов", () => {
  it("комнаты, площадь, этаж, цена", () => {
    const f = extractClipFacts("3-комнатная в Сино, 85 м2, 5 этаж, цена 550 000 сомони");
    expect(f.rooms).toBe(3);
    expect(f.areas).toEqual([85]);
    expect(f.floor).toBe(5);
    expect(f.prices).toEqual([550_000]);
  });
  it("«550к», «1,5 млн», «трёшка», «85,5 м2», «этаж 7», микрорайон", () => {
    expect(extractClipFacts("цена 550к").prices).toEqual([550_000]);
    expect(extractClipFacts("всего 1,5 млн").prices).toEqual([1_500_000]);
    expect(extractClipFacts("трёшка у парка").rooms).toBe(3);
    expect(extractClipFacts("площадь 85,5 м2").areas).toEqual([85]);
    expect(extractClipFacts("этаж 7 из 9").floor).toBe(7);
    expect(extractClipFacts("82 мкр рядом школа").microdistricts).toEqual([82]);
  });
  it("речь: «пятьсот пятьдесят тысяч» → 550000", () => {
    expect(extractClipFacts("цена пятьсот пятьдесят тысяч сомони").prices).toEqual([550_000]);
  });
});

describe("кандидаты", () => {
  it("номер в имени файла — один кандидат с причиной", () => {
    const a = prop({ shortId: 213 });
    const r = scoreClipCandidates({ filename: "213.mp4" }, [a, prop({})], districts);
    expect(r.candidates.map((c) => c.shortId)).toEqual([213]);
    expect(r.candidates[0]!.reasons).toContain("номер 213");
    expect(describeCandidate(r.candidates[0]!)).toMatch(/^ОБ-0*213: по имени файла совпали номер 213$/u);
  });
  it("по подписи: район, комнаты, цена; другой район и другое число комнат не проходят", () => {
    const hit = prop({ districtId: "d-sino", rooms: 3, price: 550_000 });
    const otherRooms = prop({ districtId: "d-sino", rooms: 2, price: 550_000 });
    const otherDistrict = prop({ districtId: "d-fir", rooms: 3, price: 900_000 });
    const r = scoreClipCandidates({ caption: "Сино 3 комнаты 550 000" }, [hit, otherRooms, otherDistrict], districts);
    expect(r.candidates.map((c) => c.propertyId)).toEqual([hit.id]);
    expect(r.candidates[0]!.reasons).toEqual(expect.arrayContaining(["район Сино", "3 комн.", "цена 550 000"]));
    expect(r.candidates[0]!.sources).toEqual(["caption"]);
  });
  it("по расшифровке (озвучке): цена и ориентир", () => {
    const hit = prop({ price: 788_000, landmark: "Альфемо", address: "кӯчаи Бухоро" });
    const r = scoreClipCandidates({ filename: "IMG_0042.MOV", transcript: "Квартира возле Альфемо, цена семьсот восемьдесят восемь тысяч" }, [hit, prop({})], districts);
    expect(r.candidates.map((c) => c.propertyId)).toEqual([hit.id]);
    expect(r.candidates[0]!.sources).toEqual(["speech"]);
    expect(describeCandidate(r.candidates[0]!)).toContain("по озвучке совпали");
  });
  it("нет совпадений — нет кандидатов", () => {
    const r = scoreClipCandidates({ filename: "IMG_1.MOV", caption: "красивый вид" }, [prop({}), prop({})], districts);
    expect(r).toEqual({ candidates: [], ambiguousCount: null });
  });
  it("три кандидата — все три с причиной; больше трёх одинаковых без отличия — «много», без кандидатов", () => {
    const three = [1, 2, 3].map(() => prop({ districtId: "d-sino", rooms: 3 }));
    const r3 = scoreClipCandidates({ caption: "Сино 3 комнаты" }, three, districts);
    expect(r3.candidates).toHaveLength(3);
    expect(r3.ambiguousCount).toBeNull();
    const many = [1, 2, 3, 4, 5].map(() => prop({ districtId: "d-sino", rooms: 3 }));
    const r5 = scoreClipCandidates({ caption: "Сино 3 комнаты" }, many, districts);
    expect(r5).toEqual({ candidates: [], ambiguousCount: 5 });
  });
  it("валюта «сомони» не называет район Исмоили Сомони; «район Сомони» — называет", () => {
    const som = prop({ districtId: "d-som", rooms: 3 });
    expect(scoreClipCandidates({ caption: "3 комнаты за 550 000 сомони" }, [som], districts).candidates).toEqual([]);
    expect(scoreClipCandidates({ caption: "район Сомони 3 комнаты" }, [som], districts).candidates.map((c) => c.propertyId)).toEqual([som.id]);
  });
  it("кандидат, которого сотрудник вести не может, не показывается", () => {
    const a = prop({ shortId: 777 });
    expect(scoreClipCandidates({ filename: "777.mp4" }, [a], districts, () => false).candidates).toEqual([]);
  });
});
