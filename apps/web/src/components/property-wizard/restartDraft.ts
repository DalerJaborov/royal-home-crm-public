/**
 * «Начать заново» в мастере: порядок «сначала DELETE серверного черновика, потом
 * всё остальное» (WEB-05, аудит 04.10.2026). Раньше автосохранение включалось ДО
 * ответа на DELETE, а его отказ глотался: PUT автосохранения (upsert по агенту)
 * находил старый черновик, не трогал его фото и возвращал его id, и новый объект
 * получал невидимые снимки прежнего; запоздавший DELETE мог ещё и стереть новые
 * загрузки. Теперь пока DELETE не прошёл, гейт остаётся на экране (шагов и
 * автосохранения нет), а отказ показывается и даёт повторить.
 *
 * `commit` включает новый мастер (закрыть гейт, очистить копии, включить
 * автосохранение); зовётся только после успешного удаления.
 */
export async function runRestartDraft(
  source: "server" | "local" | undefined,
  deps: {
    deleteServerDraft: () => Promise<unknown>;
    commit: () => void;
    fail: (message: string) => void;
  }
): Promise<boolean> {
  if (source === "server") {
    try {
      await deps.deleteServerDraft();
    } catch (err) {
      const reason = err instanceof Error && err.message ? `: ${err.message}` : "";
      deps.fail(`Не удалось удалить прежний черновик${reason}. Попробуйте ещё раз.`);
      return false;
    }
  }
  deps.commit();
  return true;
}
