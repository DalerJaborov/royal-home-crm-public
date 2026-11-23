import { SwitchRow } from "../../components/Switch";

/**
 * НОМЕР ПОД ПОСТОМ — ДВА ПЕРЕКЛЮЧАТЕЛЯ (18.11.2026; рубильник заявки — ревью #283, 20.11.2026).
 * Поведение — apps/api/src/messengers/commentPhoneLead.ts, чтение настроек — apps/api/src/lib/botAnswersItself.ts.
 * «Написать человеку и скрыть» действует только при включённой заявке: без карточки ответу клиента некуда лечь. Поэтому
 * при выключенной заявке второй переключатель недоступен, показан выключенным и честно говорит почему; своё сохранённое
 * значение он не теряет.
 */
export function CommentPhoneSwitches({ leadOn, talkOn, onToggle }: {
  leadOn: boolean;
  talkOn: boolean;
  onToggle: (field: "botCommentPhoneLead" | "botCommentPhoneConversation", next: boolean) => void;
}) {
  return (
    <>
      <SwitchRow
        title="Номер под постом: завести заявку агенту"
        on={leadOn}
        hint={
          leadOn
            ? "Номер, оставленный под постом (Instagram, Facebook, YouTube, обсуждение в Telegram), сразу становится заявкой для агента."
            : "Номер под постом заявкой не становится: комментарий разбирается как обычно, агент его не получает."
        }
        onToggle={() => onToggle("botCommentPhoneLead", !leadOn)}
      />
      <SwitchRow
        title="Номер под постом: написать человеку и скрыть"
        on={leadOn && talkOn}
        disabled={!leadOn}
        hint={
          !leadOn
            ? "Работает, только когда включено «Номер под постом: завести заявку агенту»."
            : talkOn
              ? "Кто оставил номер под постом, получает от бота одно личное сообщение с вопросом, что ему нужно, а комментарий скрывается."
              : "Под постом бот отвечает как обычно, отдельного письма про номер нет, комментарий не скрывается."
        }
        onToggle={() => onToggle("botCommentPhoneConversation", !talkOn)}
      />
    </>
  );
}
