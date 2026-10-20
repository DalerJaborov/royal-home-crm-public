import { useState } from "react";
import type { JobApplication, VacancyBucket } from "../hooks/useVacancies";
import { useSetVacancyStatus } from "../hooks/useVacancies";
import { CallClientButton } from "./CallClientButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { MutationError } from "./MutationError";
import { VacancyDetails } from "./VacancyDetails";
import { VacancyStageActions } from "./VacancyStageActions";
import { AVATAR_TONES, initials } from "../lib/theme2026Person";
import {
  VACANCY_CHECK_CHIP_CLASS,
  VACANCY_PRIORITY_DOT_CLASS,
  VACANCY_PRIORITY_HINT,
  VACANCY_PRIORITY_LABEL,
  VACANCY_PRIORITY_UNKNOWN,
  VACANCY_STATUS_CHIP,
  VACANCY_STATUS_LABEL,
  canOverrideRejected,
  isPastInterview,
  vacancyChannelLabel,
  vacancyChecks,
  vacancyInterviewLabel,
  vacancyReceivedLabel as receivedLabel,
} from "../lib/vacanciesView";

/**
 * Строка анкеты (перерисована 25.09.2026, разбор жалобы «приходят и
 * 23-летние, и те, кто работает; в зелёных электрики»): три строки вместо
 * одной. Первая — кто и когда, вторая — почему такой цвет (priorityReason),
 * третья — ЧЕТЫРЕ проверки отбора чипами, всегда видимые, а не только после
 * «Подробнее». Решение «звонить или нет» теперь принимается по самой строке.
 *
 * Точка слева красит только GREEN: жёлтый/красный намеренно нейтральны (тот
 * же выбор, что уже был у VACANCY_PRIORITY_CHIP) — цвет здесь подсказка, а
 * не единственный носитель смысла, само слово есть во второй строке.
 */
export function VacancyRow({ item, tone, bucket }: { item: JobApplication; tone: number; bucket: VacancyBucket }) {
  const [open, setOpen] = useState(false);
  const [confirmNotCandidate, setConfirmNotCandidate] = useState(false);
  // Полоса под строкой для формы стадии (дата собеседования и т.п.): в колонке
  // кнопок форма сжимала всю строку — см. formHost в VacancyStageActions.
  const [formHost, setFormHost] = useState<HTMLDivElement | null>(null);
  const setStatus = useSetVacancyStatus();
  const title = item.name ?? item.contactName ?? "Кандидат без имени";
  const overdueInterview = item.status === "INTERVIEW" && item.interviewAt && isPastInterview(item.interviewAt);
  const checks = vacancyChecks(item);
  const priorityTitle = item.priority ? item.priorityReason ?? VACANCY_PRIORITY_HINT[item.priority] : item.customerInquiryId
    ? "Профессиональные сведения и портфолио оценивает HR." : VACANCY_PRIORITY_UNKNOWN.hint;

  return (
    <>
      <div className="row">
        <span
          className={item.priority ? VACANCY_PRIORITY_DOT_CLASS[item.priority] : VACANCY_PRIORITY_UNKNOWN.dotClass}
          title={priorityTitle}
        />
        <span className="av" style={AVATAR_TONES[tone % AVATAR_TONES.length]}>
          {initials(title)}
        </span>
        <div className="t">
          <b>
            <button className="lk" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {/* Возраст внутри кнопки: снаружи он на телефоне отрывался от имени
                  на отдельную строку («Шерали» / «, 29»). */}
              {title}
              {item.age !== null ? `, ${item.age}` : ""}
            </button>
          </b>
          <span>
            {[item.positionTitle, item.city, vacancyChannelLabel(item.channel), receivedLabel(item.createdAt)].filter(Boolean).join(" · ")}
            {item.status === "INTERVIEW" && item.interviewAt
              ? `. Собеседование ${vacancyInterviewLabel(item.interviewAt)}${overdueInterview ? ", срок прошёл" : ""}`
              : ""}
            {item.status === "HIRED" && item.hiredAt ? `. Вышел на работу ${receivedLabel(item.hiredAt)}` : ""}
          </span>
          <span>
            {item.priority
              ? // Причину пишет код уже с названием цвета («Опыт продаж: …») — подпись
                // перед ней давала «Опыт продаж: Опыт продаж: …».
                item.priorityReason ?? VACANCY_PRIORITY_LABEL[item.priority]
              : item.customerInquiryId ? "Требуется оценка HR" : VACANCY_PRIORITY_UNKNOWN.label}
          </span>
          <div className="wrap" style={{ marginTop: 2 }}>
            {/* Стадия — в плоских списках «Дособрать»/«Не подходят» (02.10.2026):
                там нет секций по стадиям, и без чипа не видно, что кандидата
                уже позвали на собеседование или приняли. В «Подходят» стадию
                называет заголовок секции. */}
            {bucket !== "fit" && item.status !== "NOT_CANDIDATE" && (
              <span className={VACANCY_STATUS_CHIP[item.status]}>{VACANCY_STATUS_LABEL[item.status]}</span>
            )}
            {checks.map((c) => (
              <span key={c.key} className={VACANCY_CHECK_CHIP_CLASS[c.state]}>
                {c.label}
              </span>
            ))}
            {item.cvFile && <span className="chip">резюме</span>}
          </div>
        </div>
        <div className="act many">
          {/* Телефон есть не у всех: у кого нет, честная пометка выше в строке.
              Писать такому кандидату можно только в переписке (владелец 03.09.2026). */}
          {item.phone && (
            // Через CallClientButton, а не голой ссылкой tel: правило звонка живёт
            // в одном месте. У анкеты карточки клиента нет — звонок идёт через
            // станцию своим путём POST /vacancies/:id/call (29.09.2026).
            <CallClientButton
              candidateId={item.id}
              phone={item.phone}
              variant="full"
              label="Позвонить"
              className="pill ghost sm"
              title={`Позвонить кандидату ${item.phone}`}
            />
          )}
          <VacancyStageActions item={item} formHost={formHost} />
          {/* Корзина «Не подходят» (25.09.2026): быстрый обход автоматического
              отказа. 02.10.2026: одной смены стадии мало — корзину решает отбор
              (eligible), а не стадия, и кандидат оставался в «Не подходят».
              Поэтому вместе со стадией уходит eligibleOverride. И только для
              NEW/REVIEWED/REJECTED: у «Собеседование»/«Принят» нажатие
              откатывало стадию и гасило звонок робота (canOverrideRejected). */}
          {bucket === "rejected" && canOverrideRejected(item) && (
            <button
              className="pill ghost sm"
              type="button"
              disabled={setStatus.isPending}
              title="Перевести анкету в работу, несмотря на отказ по возрасту, учёбе или занятости"
              onClick={() => setStatus.mutate({ id: item.id, status: "REVIEWED", eligibleOverride: true })}
            >
              Всё равно позвать
            </button>
          )}
          {/* «Не кандидат» — анкету завели по ошибке (продавец, покупатель), а не
              отказ по итогам разбора; корзина «Не подходят» уже и есть отказ, там
              своей кнопки не нужно. */}
          {bucket !== "rejected" && (
            <button
              className="lnk"
              type="button"
              disabled={setStatus.isPending}
              title="Анкету завели по ошибке — это не кандидат на вакансию (продавец, покупатель)"
              onClick={() => setConfirmNotCandidate(true)}
            >
              Не кандидат
            </button>
          )}
          <button className="lnk" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Свернуть" : "Подробнее"}
          </button>
        </div>
      </div>
      <div ref={setFormHost} className="row-form" style={{ paddingLeft: 40 }} />
      {open && <VacancyDetails item={item} />}
      {confirmNotCandidate && (
        <ConfirmDialog
          title="Отметить «Не кандидат»?"
          description={`«${title}» пропадёт из раздела «Вакансии»: анкету завели по ошибке (например, продавец или покупатель, а не кандидат на работу). Дальше её не видно ни в одной корзине.`}
          confirmLabel="Не кандидат"
          danger
          onConfirm={() =>
            setStatus.mutate({ id: item.id, status: "NOT_CANDIDATE" }, { onSuccess: () => setConfirmNotCandidate(false) })
          }
          onCancel={() => setConfirmNotCandidate(false)}
        >
          <MutationError mutation={setStatus} fallback="Не удалось сохранить" />
        </ConfirmDialog>
      )}
    </>
  );
}
