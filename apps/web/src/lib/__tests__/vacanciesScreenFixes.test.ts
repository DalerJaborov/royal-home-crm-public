// Пояс НЕ душанбинский — до любых импортов: старая форма читала поле часами
// устройства, и на машине в UTC+5 её ошибку не видно вовсе.
process.env.TZ = "Europe/Istanbul";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../apiError";
import { AUDIT_ACTION_LABELS } from "../audit";
import { openPrivateFile, REVOKE_AFTER_MS, type OpenPrivateFileDeps } from "../openPrivateFile";
import {
  VACANCY_ACTIONS_NOTE,
  VACANCY_ACTION_HINT,
  VACANCY_SEARCH_MAX,
  canOverrideRejected,
  canTransferClientToCandidates,
  interviewInputToIso,
  interviewIsoToInput,
  inviteCallNoteToShow,
  vacanciesLoadErrorText,
  vacancyChannelLabel,
  vacancyChatLanguageText,
  VACANCY_LIST_MAX,
  vacancyShownNote,
  vacancyTodayInterviews,
} from "../vacanciesView";
import type { JobApplication } from "../../hooks/useVacancies";

/**
 * Экран «Вакансии», разбор 02.10.2026 (S1–S17, A9, A10b). Каждая проверка
 * красная на прежнем коде. Разметку здесь не отрисовать (jsdom не стоит, см.
 * noApiHrefs.test.ts), поэтому правила вынесены в lib/vacanciesView.ts и
 * lib/openPrivateFile.ts, а места вызова проверяются по исходнику.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("S1: дата собеседования — по Душанбе, а не по часам устройства", () => {
  it("пояс теста действительно не UTC+5 (иначе проверка ниже ничего не ловит)", () => {
    // Ровно то, что делала прежняя форма: new Date(поле).toISOString().
    expect(new Date("2026-10-05T14:00").toISOString()).toBe("2026-10-05T11:00:00.000Z");
  });

  it("14:00 в поле — это 14:00 в Душанбе, то есть 09:00 UTC", () => {
    expect(interviewInputToIso("2026-10-05T14:00")).toBe("2026-10-05T09:00:00.000Z");
    // Секунды, если браузер их дописал, не мешают.
    expect(interviewInputToIso("2026-10-05T14:00:00")).toBe("2026-10-05T09:00:00.000Z");
  });

  it("«Перенести» заполняет поле душанбинским временем", () => {
    expect(interviewIsoToInput("2026-10-05T09:00:00.000Z")).toBe("2026-10-05T14:00");
    // Через полночь: 21:30 UTC — это уже следующий день в Душанбе.
    expect(interviewIsoToInput("2026-10-05T21:30:00.000Z")).toBe("2026-10-06T02:30");
  });

  it("туда и обратно — то же время", () => {
    expect(interviewInputToIso(interviewIsoToInput("2026-12-31T23:15:00.000Z"))).toBe("2026-12-31T23:15:00.000Z");
  });

  it("пустое или кривое поле — null, а не исключение", () => {
    expect(interviewInputToIso("")).toBeNull();
    expect(interviewInputToIso("завтра")).toBeNull();
    expect(interviewInputToIso("2026-13-45T25:00")).toBeNull();
  });

  it("форма зовёт эти правила, а не new Date(поле)", () => {
    const src = read("components/VacancyStageActions.tsx");
    expect(src).toContain("interviewInputToIso");
    expect(src).toContain("interviewIsoToInput(item.interviewAt)");
    expect(src).not.toContain("toLocalDateTimeInput");
    expect(src).not.toMatch(/new Date\(local\)/);
  });
});

describe("S2: «Всё равно позвать»", () => {
  it("только для новых, просмотренных и отказанных", () => {
    expect(canOverrideRejected({ status: "NEW" })).toBe(true);
    expect(canOverrideRejected({ status: "REVIEWED" })).toBe(true);
    expect(canOverrideRejected({ status: "REJECTED" })).toBe(true);
    expect(canOverrideRejected({ status: "INTERVIEW" })).toBe(false);
    expect(canOverrideRejected({ status: "INTERVIEWED" })).toBe(false);
    expect(canOverrideRejected({ status: "HIRED" })).toBe(false);
  });

  it("ручное решение остаётся в панели, очередь показывает стадию без мутаций", () => {
    const src = read("components/VacancyStageActions.tsx");
    expect(src).toContain("canOverrideRejected(item)");
    expect(src).toContain('{ id: item.id, status: "REVIEWED", eligibleOverride: true }');
    const queue = read("components/VacancyRow.tsx");
    expect(queue).toContain("CANDIDATE_STAGE_LABELS[item.status]");
    expect(queue).not.toContain("mutate(");
  });
});

describe("S6: форма собеседования", () => {
  it("сохранение даты не включает звонок, приглашение имеет отдельный выбор и min", () => {
    const src = read("components/VacancyStageActions.tsx");
    expect(src).toContain("min={interviewIsoToInput(new Date())}");
    expect(src).not.toContain("inviteCall: true");
    const contact = read("components/VacancyContactForm.tsx");
    expect(contact).toContain('channels.includes("ASSISTANT_CALL")');
    expect(contact).toContain("Посмотреть приглашение");
  });

  it("причина «звонка не будет» показывается, только когда сервер её прислал", () => {
    expect(inviteCallNoteToShow({ ok: true, inviteCallQueued: false, inviteCallNote: "Номер не таджикский" })).toBe(
      "Номер не таджикский"
    );
    expect(inviteCallNoteToShow({ ok: true, inviteCallQueued: true, inviteCallNote: "x" })).toBeNull();
    expect(inviteCallNoteToShow({ ok: true, inviteCallQueued: false })).toBeNull();
    expect(inviteCallNoteToShow({ ok: true })).toBeNull();
    expect(inviteCallNoteToShow(undefined)).toBeNull();
  });
});

describe("S7: подсказки не спорят с галочкой робота", () => {
  it("нет «ни сообщение, ни звонок» и безусловного «позвоните ему сами»", () => {
    expect(VACANCY_ACTIONS_NOTE).not.toContain("ни звонок");
    expect(VACANCY_ACTIONS_NOTE).toMatch(/робот/i);
    expect(VACANCY_ACTION_HINT.interview).not.toContain("Приглашение кандидату не отправляется");
    expect(VACANCY_ACTION_HINT.interview).toMatch(/один раз/);
  });
});

describe("S9: канал — словами, никогда кодом", () => {
  it.each([
    "INSTAGRAM",
    "WHATSAPP",
    "FACEBOOK",
    "TELEGRAM",
    "WEBSITE",
    "PHONE_CALL",
    "WALK_IN",
    "REFERRAL",
    "GOOGLE_ADS",
    "TELEGRAM_DM",
    "LIVE_VOICE",
    "TELEGRAM_DIRECT",
  ])("%s", (code) => {
    const label = vacancyChannelLabel(code);
    expect(label).not.toBe(code);
    expect(label).not.toMatch(/^[A-Z_]+$/);
    expect(label).not.toBe("Другое");
  });

  it("незнакомый или пустой — «Другое»", () => {
    expect(vacancyChannelLabel("SOMETHING_NEW")).toBe("Другое");
    expect(vacancyChannelLabel(null)).toBe("Другое");
    expect(vacancyChannelLabel("")).toBe("Другое");
  });
});

describe("S11: чипы проверок сохраняют цвет внутри строки", () => {
  it("переопределение сильнее `.rh2 .scr .row .t span` лежит в несобираемом файле", () => {
    const css = read("theme-2026-color-layer.css");
    expect(css).toMatch(/\.rh2 \.scr \.row \.t span\.chip\.ok\{color:var\(--ok\)\}/);
    expect(css).toMatch(/\.rh2 \.scr \.row \.t span\.chip\.crit\{color:var\(--crit\)\}/);
  });
});

describe("S12: «Открыть файл» резюме", () => {
  function fakeDeps(load: () => Promise<Blob>, win: { location: { href: string }; close: () => void } | null) {
    const calls: string[] = [];
    const deps: OpenPrivateFileDeps = {
      open: vi.fn(() => {
        calls.push("open");
        return win;
      }),
      load: vi.fn(() => {
        calls.push("load");
        return load();
      }),
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
      download: vi.fn(),
      later: vi.fn((fn: () => void) => fn()),
    };
    return { deps, calls };
  }

  it("окно открывается ДО скачивания, получает файл, ссылка отзывается", async () => {
    const win = { location: { href: "" }, close: vi.fn() };
    const { deps, calls } = fakeDeps(() => Promise.resolve(new Blob(["pdf"])), win);
    const result = openPrivateFile("cv.pdf", deps);
    // Синхронно, в том же обработчике нажатия.
    expect(calls).toEqual(["open", "load"]);
    expect(await result).toBe(true);
    expect(win.location.href).toBe("blob:x");
    expect(deps.later).toHaveBeenCalledWith(expect.any(Function), REVOKE_AFTER_MS);
    expect(deps.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  it("окно заблокировано — файл скачивается ссылкой", async () => {
    const { deps } = fakeDeps(() => Promise.resolve(new Blob(["pdf"])), null);
    expect(await openPrivateFile("cv.pdf", deps)).toBe(true);
    expect(deps.download).toHaveBeenCalledWith("blob:x", "cv.pdf");
  });

  it("не скачалось — пустое окно закрывается, вызывающий узнаёт об ошибке", async () => {
    const win = { location: { href: "" }, close: vi.fn() };
    const { deps } = fakeDeps(() => Promise.reject(new Error("net")), win);
    expect(await openPrivateFile("cv.pdf", deps)).toBe(false);
    expect(win.close).toHaveBeenCalled();
    expect(deps.createObjectURL).not.toHaveBeenCalled();
  });

  it("карточка анкеты пользуется этим, а не window.open после await", () => {
    const src = read("components/VacancyDetails.tsx");
    // 02.10.2026: второй аргумент — загрузка резюме маршрутом раздела (A6).
    expect(src).toContain("openPrivateFile(file, browserDeps(load))");
    expect(src).not.toContain("window.open");
  });
});

describe("S13: язык переписки", () => {
  it("правильным русским и без кода", () => {
    expect(vacancyChatLanguageText("ru")).toBe("русский");
    expect(vacancyChatLanguageText("tg")).toBe("таджикский");
    expect(vacancyChatLanguageText("mixed")).toBe("русский и таджикский");
    expect(vacancyChatLanguageText("kk")).toBe("другой");
    const src = read("components/VacancyDetails.tsx");
    expect(src).not.toContain("Пишет по-");
    expect(src).toContain("vacancyChatLanguageText(item.chatLanguage)");
    expect(src).toContain("Язык не указан");
  });
});

describe("S14: поиск длиннее предела сервера", () => {
  it("поле не даёт набрать больше 80 знаков", () => {
    expect(VACANCY_SEARCH_MAX).toBe(80);
    expect(read("pages/Vacancies.tsx")).toContain("maxLength={VACANCY_SEARCH_MAX}");
  });

  it("ошибка списка — словами, без текста сервера", () => {
    const text = vacanciesLoadErrorText(new ApiError("Неверные данные", 400, { details: {} }));
    expect(text).not.toContain("Неверные данные");
    expect(text).toMatch(/поиск/);
    expect(vacanciesLoadErrorText(new Error("Failed to fetch"))).not.toContain("Failed");
    expect(read("pages/Vacancies.tsx")).not.toContain("error.message");
  });
});

describe("S15: журнал «Архива» — подписи действий в нижнем регистре", () => {
  it("итоги звонков робота подписаны, VACANCY_STATUS — про кандидата", () => {
    for (const key of ["interview_invite_call_outcome", "post_showing_call_outcome", "seller_probe_call_outcome"]) {
      expect(AUDIT_ACTION_LABELS[key]).toBeTruthy();
    }
    expect(AUDIT_ACTION_LABELS.VACANCY_STATUS).toBe("Кандидат: смена этапа");
  });
});

describe("S17: дата открывается в доступном модальном окне", () => {
  it("форма не раздувает колонку действий кандидата", () => {
    const src = read("components/VacancyStageActions.tsx");
    expect(src).toContain("<Rh2Sheet");
    expect(src).toContain("closeOnBackdrop={false}");
    expect(read("pages/Vacancies.tsx")).toContain("<VacancyStageActions item={current}");
  });
});

describe("A9: «Перевести в кандидаты» — по правам", () => {
  it("нужны и clients.assign, и clients.delete", () => {
    const only = (...ids: string[]) => (p: string) => ids.includes(p);
    expect(canTransferClientToCandidates(only("clients.assign", "vacancies.view"))).toBe(true);
    expect(canTransferClientToCandidates(only("clients.assign"))).toBe(false);
    expect(canTransferClientToCandidates(only("vacancies.view"))).toBe(false);
    expect(read("pages/ClientDetail.tsx")).toMatch(/canTransferClientToCandidates\(canDo\) && !client\.deletedAt/);
  });
});

describe("A10b: приглашение не уводит в социальные сообщения", () => {
  it("переписка читается через разрешённый endpoint вакансии, исходящих ссылок нет", () => {
    const src = read("components/VacancyDetails.tsx");
    expect(src).toContain("useVacancyConversation(item.id)");
    expect(src).not.toContain("/messages?open=");
    expect(read("components/VacancyContactForm.tsx")).not.toContain("/messages?open=");
  });
});

describe("A6: резюме открывается маршрутом раздела, а не общими вложениями", () => {
  it("карточка качает /vacancies/:id/cv", () => {
    const src = read("components/VacancyDetails.tsx");
    expect(src).toContain("/vacancies/${encodeURIComponent(applicationId)}/cv");
    expect(src).not.toContain("/attachments/");
  });
});

describe("S8: «Показаны N из M»", () => {
  it("всё показано — строки нет", () => {
    expect(vacancyShownNote(40, 40, 100)).toBeNull();
    // Старый сервер total не присылает — молчим, как раньше.
    expect(vacancyShownNote(100, undefined, 100)).toBeNull();
  });

  it("часть показана — говорит сколько и даёт «Показать ещё»", () => {
    expect(vacancyShownNote(100, 340, 100)).toEqual({ text: "Показаны 100 из 340.", canLoadMore: true });
  });

  it("на пределе сервера — подсказывает искать, кнопки нет", () => {
    const note = vacancyShownNote(VACANCY_LIST_MAX, 340, VACANCY_LIST_MAX);
    expect(note?.canLoadMore).toBe(false);
    expect(note?.text).toContain("Показаны 200 из 340");
  });

  it("очередь использует серверные страницы, включая кандидатов после двухсотой анкеты", () => {
    const src = read("pages/Vacancies.tsx");
    expect(src).toContain("candidateQueuePage(");
    expect(src).toContain("Предыдущие"); expect(src).toContain("Следующие");
    expect(src).toContain("limit: CANDIDATE_QUEUE_PAGE_SIZE, offset,");
    expect(src).not.toContain("VACANCY_LIST_MAX");
  });
});

describe("L7: «Сегодня» — все собеседования дня, а не только загруженные", () => {
  const row = (id: string, interviewAt: string | null, status: JobApplication["status"] = "INTERVIEW") =>
    ({ id, status, interviewAt }) as JobApplication;

  it("берёт отдельный список сервера, даже если на странице их нет", () => {
    const today = [row("old", new Date().toISOString())];
    expect(vacancyTodayInterviews({ items: [], todayInterviews: today }).map((i) => i.id)).toEqual(["old"]);
  });

  it("старый сервер — запасной путь по странице", () => {
    const items = [row("a", new Date().toISOString()), row("b", null, "NEW")];
    expect(vacancyTodayInterviews({ items }).map((i) => i.id)).toEqual(["a"]);
  });

  it("экран собирает «Сегодня» через это правило", () => {
    expect(read("pages/Vacancies.tsx")).toContain("vacancyTodayInterviews(data)");
  });
});
