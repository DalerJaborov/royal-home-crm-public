import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ КЛАССА «фото объекта — одна дверь» (ревью #331): КАЖДЫЙ `<img` в apps/web/src —
 * либо фото объекта через PropertyPhoto, либо стоит в списке ниже с причиной и ТОЧНЫМ
 * числом тегов в файле. Прежний сторож искал «фото» регуляркой внутри тега и рвался на
 * `=>` в onError — семь фото объектов проходили мимо. Теперь неважно, что в теге: новый
 * `<img` в любом файле краснит, пока его не перевели на PropertyPhoto или не вписали сюда
 * с причиной. Список только убывает (лишняя или устаревшая запись тоже краснит).
 */
const IMG_ALLOWED: Record<string, { count: number; why: string }> = {
  "components/property/PropertyPhoto.tsx": { count: 1, why: "сама дверь" },
  // не фото объекта
  "components/MessageAttachments.tsx": { count: 2, why: "вложения переписки" },
  "pages/Messages.tsx": { count: 2, why: "вложения и загрузка в чате" },
  "components/mobile/MobileChatView.tsx": { count: 2, why: "вложения и загрузка в чате" },
  "components/ProfileAvatar.tsx": { count: 1, why: "аватар сотрудника" },
  "components/Sidebar.tsx": { count: 1, why: "аватар сотрудника" },
  "components/SellerPicker.tsx": { count: 1, why: "аватар продавца" },
  "components/look/ui.tsx": { count: 1, why: "аватар (RhAvatar)" },
  "components/clean/ui.tsx": { count: 1, why: "аватар прежнего чистого вида" },
  "components/pult/EventFeed.tsx": { count: 1, why: "аватар в ленте событий" },
  "pages/Activity.tsx": { count: 1, why: "аватар сотрудника" },
  "pages/MarketingCenter.tsx": { count: 1, why: "аватар сотрудника" },
  "pages/Reports.tsx": { count: 1, why: "аватар сотрудника" },
  "pages/Team.tsx": { count: 3, why: "аватары сотрудников" },
  "pages/TeamMemberDetail.tsx": { count: 2, why: "аватар сотрудника" },
  "pages/Profile.tsx": { count: 2, why: "своё фото профиля" },
  "pages/settings/TeamTab.tsx": { count: 1, why: "аватар сотрудника" },
  "pages/settings/AgencyTab.tsx": { count: 1, why: "логотип агентства" },
  "pages/settings/ChannelsTab.tsx": { count: 2, why: "QR-код и аватар канала" },
  "pages/Login.tsx": { count: 1, why: "логотип на входе" },
  "components/TwoFactorSettings.tsx": { count: 1, why: "QR-код двухфакторного входа" },
  "components/marketing/TikTokInsightsPanel.tsx": { count: 2, why: "аватар и обложки роликов TikTok" },
  "components/ads/UnmatchedGallery.tsx": { count: 1, why: "превью рекламного креатива Meta, не фото объекта" },
  "components/PropertyCoverStatus.tsx": { count: 2, why: "сгенерированные обложки для соцсетей" },
  "components/PropertyVideoFixCard.tsx": { count: 1, why: "карточка для истории (blob), не фото" },
  "components/socialVideos/CoverPicker.tsx": { count: 1, why: "обложка ролика" },
  "pages/SocialVideos.tsx": { count: 1, why: "обложка ролика" },
  "pages/socialVideos/VideoDetail.tsx": { count: 2, why: "обложка и кадры ролика" },
  "pages/socialVideos/PhotoPicker.tsx": { count: 1, why: "выбор кадров для ролика" },
  "pages/settings/CoverTemplatesSection.tsx": { count: 1, why: "превью шаблона обложки (blob)" },
  "pages/settings/OpenAiCoversSection.tsx": { count: 3, why: "превью обложек ИИ" },
  "components/OwnerQuestionsBanner.tsx": { count: 1, why: "значок вопроса собственника 44 px, своя вёрстка" },
  "components/clean/CleanPropertyIllustration.tsx": { count: 1, why: "иллюстрация-заглушка, не фото" },
  // предпросмотр выбранных файлов и полноэкранный просмотр
  "components/PhotoLightbox.tsx": { count: 2, why: "просмотр во весь экран, свой слой" },
  "components/property-wizard/StepMedia.tsx": { count: 1, why: "предпросмотр только что выбранного файла" },
  "components/property-wizard/DraftGate.tsx": { count: 1, why: "предпросмотр файлов черновика" },
  "components/PropertyFormModal.tsx": { count: 1, why: "предпросмотр выбранного файла" },
  // публичные страницы — своя вёрстка без оболочки CRM
  "pages/PublicOwnerReport.tsx": { count: 2, why: "публичный отчёт собственнику" },
  "pages/PublicPropertyShare.tsx": { count: 1, why: "публичная страница объекта для клиента" },
  // «Новый вид» по макету: без фото — круг-значок, а не заглушка «Фото недоступно»
  "components/look/home/parts.tsx": { count: 1, why: "строка главной: без фото круг-значок по макету, onError есть" },
  "components/look/deals/RoyalDealRows.tsx": { count: 1, why: "строка сделки: без фото круг-значок по макету, onError есть" },
  // уходят вместе со старой темой (волна 3 плана «одна оболочка»)
  "components/clean/CleanDecisionRow.tsx": { count: 1, why: "прежний чистый вид, удаляется волной 3; onError есть" },
  "components/clean/CleanFeaturedProperty.tsx": { count: 1, why: "прежний чистый вид, удаляется волной 3; onError есть" },
  "components/clean/CleanPropertyItem.tsx": { count: 1, why: "прежний чистый вид, удаляется волной 3; onError есть" },
  "components/clean/CleanPropertyReviewSheet.tsx": { count: 1, why: "прежний чистый вид, удаляется волной 3" },
  "components/clean/CleanWorkQueues.tsx": { count: 1, why: "прежний чистый вид, удаляется волной 3; onError есть" },
  "pages/PultClean.tsx": { count: 1, why: "прежний пульт чистого вида, удаляется волной 3; onError есть" },
  "components/mobile/MobilePropertiesList.tsx": { count: 1, why: "старый телефонный список, удаляется вместе с Mobile*" },
  "components/mobile/PropertyMobileBlocks.tsx": { count: 1, why: "старая телефонная карточка агента, удаляется вместе с Mobile*" },
};

/**
 * Число тегов `<img` в исходнике без комментариев: блочный комментарий считается
 * таковым, только если начинается в начале строки, после пробела или `{`
 * (так строка `accept="image/*"` не открывает «комментарий»), и строчный — после пробела.
 */
export function countImgTags(source: string): number {
  const code = source
    .replace(/(^|[\s{])\/\*[\s\S]*?\*\//gm, "$1")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  return (code.match(/<img\b/g) ?? []).length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

function imgCounts(): Record<string, number> {
  const root = path.resolve(__dirname, "../..");
  const counts: Record<string, number> = {};
  for (const file of walk(root)) {
    const n = countImgTags(readFileSync(file, "utf8"));
    if (n) counts[path.relative(root, file).split(path.sep).join("/")] = n;
  }
  return counts;
}

describe("PropertyPhoto guard: каждый <img в apps/web/src", () => {
  it("нет ни одного <img вне списка, и в каждом файле ровно столько, сколько записано", () => {
    const allowed = Object.fromEntries(Object.entries(IMG_ALLOWED).map(([file, { count }]) => [file, count]));
    expect(imgCounts()).toEqual(allowed);
  });
  it("счётчик не обманывается onError со стрелкой, многострочным тегом и `image/*` в строке (проверен поломкой)", () => {
    expect(countImgTags("<img src={p.photos[0].url} onError={() => setBad(true)} />")).toBe(1);
    expect(countImgTags("<img\n  src={cover}\n  alt=\"\"\n/>")).toBe(1);
    expect(countImgTags("<input accept=\"image/*\" />\n<img src={x} />\n<b>*/</b>")).toBe(1);
    expect(countImgTags("{/* голый <img> был здесь */}\n// <img src={old} />")).toBe(0);
  });
  it("у каждой записи списка есть причина", () => {
    for (const [file, { why }] of Object.entries(IMG_ALLOWED)) expect(why.length, file).toBeGreaterThan(5);
  });
});
