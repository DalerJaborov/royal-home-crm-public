import { NarrationPreviewBlock } from "../../components/NarrationPreviewBlock";

/**
 * Дев-стенд «Прослушать перед выпуском» (18.11.2026) — только `import.meta.env.DEV`, вне входа:
 * кадры ПК/телефона и обе темы без засеянной базы. Видео — любой mp4 в apps/web/public/dev-sample.mp4
 * (в git не кладётся; нет файла — плеер показывает свою заглушку).
 */
const now = Date.now();
const versions = [
  { id: "v3", revision: 3, script: "Новая цена.", voiceId: "a", status: "READY", approvedAt: null, stale: false, hasAudio: true, errorCode: null, createdAt: new Date(now).toISOString() },
  { id: "v2", revision: 2, script: "Старая цена.", voiceId: "a", status: "READY", approvedAt: null, stale: false, hasAudio: true, errorCode: null, createdAt: new Date(now - 86_400_000).toISOString() },
];
const preview = {
  versionId: "v3", revision: 3, previewPath: "/dev-sample.mp4", currentPath: "/dev-sample.mp4", oldVersionId: "v2",
  createdAt: new Date(now).toISOString(), dueAt: new Date(now + 3 * 3_600_000).toISOString(), voiceSec: 33.6, clipSec: 36.2,
  note: "Голос чуть длиннее ролика: CRM ускорила его на 5 %.", canDecide: true,
};

export default function NarrationPreviewPlayground() {
  return (
    // Та же обёртка, что у карточки объекта (PropertyDetail): стили .pill живут под .rh2 .scr.
    <div className="rh2 screens"><main className="scr mx-auto max-w-3xl space-y-6 p-4">
      <h1 className="text-lg font-semibold">Прослушать перед выпуском — дев-стенд</h1>
      <section className="space-y-2">
        <p className="text-sm text-muted-foreground">Хозяин объекта: решение и срок</p>
        <NarrationPreviewBlock propertyId="dev" data={{ preview, previewDeclined: false, versions }} />
      </section>
      <section className="space-y-2">
        <p className="text-sm text-muted-foreground">Не хозяин: только просмотр</p>
        <NarrationPreviewBlock propertyId="dev" data={{ preview: { ...preview, canDecide: false, dueAt: null }, previewDeclined: false, versions }} />
      </section>
      <section className="space-y-2">
        <p className="text-sm text-muted-foreground">Хозяин оставил старый ролик</p>
        <NarrationPreviewBlock propertyId="dev" data={{ preview: null, previewDeclined: true, versions }} />
      </section>
    </main></div>
  );
}
