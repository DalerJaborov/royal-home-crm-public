import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { morningBriefingSchema, type MorningBriefing } from "@royal-home/shared";
import { api } from "../../lib/api";
import { dushanbeHour } from "../../lib/date";
import { briefingCardMode, markBriefingSeen, readBriefingSeen } from "../../lib/briefingView";
import { MhSection } from "../home/mh/MhScreen";

/**
 * Карточка «Утренний брифинг» на главной директора.
 *
 * ЗАЧЕМ. Те же числа, что в 08:00 уходят push-сводкой в телефон, директор
 * должен видеть и внутри CRM — и слышать голосом лица ИИ, а не вычитывать
 * из уведомления. Текст пишет сервер (api lib/morningBriefing.ts), один раз в
 * сутки; здесь только показ и воспроизведение.
 *
 * ОДИН КОМПОНЕНТ НА ПК И ТЕЛЕФОН. Своей мобильной копии у карточки нет и не
 * будет: узкую раскладку делают медиазапросы темы 2026 (820 и 640 px), а
 * вторая копия — это ровно тот механизм, из-за которого красные флаги
 * «Присмотра» полгода не доезжали до телефона.
 *
 * НИКАКОГО АВТОВОСПРОИЗВЕДЕНИЯ. Звук стартует только по нажатию: iOS не даст
 * играть без жеста, а директор, открывший CRM на совещании, не должен
 * внезапно докладывать вслух на всю комнату.
 */

/**
 * Классы `.brief-*` заданы в theme-royal-home-2026.css (нашем файле, не в
 * генерируемом theme-2026-proto.css). Идиомы `.sec-t`/`.quiet` здесь не
 * годятся: в прототипе они существуют только под `.rh2 .scr`, а пульт — своя
 * ветка разметки, и на нём такая секция осталась бы вовсе без стиля.
 */

function useBriefingQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["dashboard", "briefing"],
    queryFn: async () => morningBriefingSchema.parse(await api<MorningBriefing>("/dashboard/briefing")),
    enabled,
    // Брифинг на сервере и так кеширован на сутки — дёргать его чаще незачем.
    staleTime: 30 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Воспроизведение WAV брифинга. WAV лежит за авторизацией, поэтому его нельзя
 * отдать в `new Audio(url)`: файл забирается через `api()` как blob и играется
 * из object URL.
 */
function useBriefingAudio(audioUrl: string | null | undefined) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setPlaying(false);
  }, []);

  // Уйти с главной и слушать доклад в пустоту нельзя: элемент <audio>
  // переживает размонтирование, если его не остановить руками.
  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    },
    []
  );

  const play = useCallback(async () => {
    if (!audioUrl) return;
    if (playing) {
      stop();
      return;
    }
    try {
      let audio = audioRef.current;
      if (!audio) {
        const blob = await api<Blob>(audioUrl, { responseType: "blob" });
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        audio = new Audio(url);
        audio.addEventListener("play", () => {
          setPlaying(true);
        });
        const finish = () => {
          setPlaying(false);
        };
        audio.addEventListener("ended", finish);
        audio.addEventListener("pause", finish);
        audio.addEventListener("error", () => {
          finish();
          setFailed(true);
        });
        audioRef.current = audio;
      }
      await audio.play();
    } catch {
      // Сеть, отсутствующий файл, отказ автоплея — карточка остаётся с текстом.
      setPlaying(false);
      setFailed(true);
    }
  }, [audioUrl, playing, stop]);

  return { playing, failed, play };
}

export function MorningBriefingCard({
  enabled,
  variant = "pult",
}: {
  enabled: boolean;
  /** «pult» — карточка пульта на ПК, «mobile» — секция мобильной главной. */
  variant?: "pult" | "mobile";
}) {
  const { data, isLoading, isError } = useBriefingQuery(enabled);
  const { playing, failed, play } = useBriefingAudio(data?.audioUrl);

  const [seen, setSeen] = useState(false);
  const [openedByHand, setOpenedByHand] = useState(false);

  // «Прослушан/закрыт сегодня» читается из localStorage только когда известна
  // дата брифинга: ключ привязан к дате по Душанбе, чтобы назавтра карточка
  // развернулась сама.
  useEffect(() => {
    if (data?.dushanbeDate) setSeen(readBriefingSeen(data.dushanbeDate));
  }, [data?.dushanbeDate]);

  const dismiss = useCallback(() => {
    if (data?.dushanbeDate) markBriefingSeen(data.dushanbeDate);
    setSeen(true);
    setOpenedByHand(false);
  }, [data?.dushanbeDate]);

  if (!enabled) return null;

  const inner = (() => {
    if (isLoading) return <span className="sk w40" />;
    // Отказ эндпоинта не должен занимать место своей плашкой: числа директор
    // всё равно видит ниже, а красный блок про то, чего он не просил, хуже
    // отсутствия карточки.
    if (isError || !data) return null;

    const expanded = openedByHand || briefingCardMode(dushanbeHour(), seen) === "expanded";
    if (!expanded) {
      return (
        <button type="button" className="brief-btn" onClick={() => setOpenedByHand(true)}>
          Брифинг за сегодня
        </button>
      );
    }

    return (
      <>
        <p className="brief-text">{data.text}</p>
        {data.source === "fallback" && (
          <p className="brief-note">Текст собран по числам: ИИ сейчас недоступен.</p>
        )}
        <div className="brief-row">
          {data.audioUrl && !failed ? (
            <button type="button" className="brief-btn" onClick={() => void play()}>
              {playing ? "Стоп" : "Прослушать"}
            </button>
          ) : (
            <p className="brief-note">Озвучка недоступна.</p>
          )}
          <button type="button" className="brief-btn" onClick={dismiss}>
            Скрыть до завтра
          </button>
        </div>
      </>
    );
  })();

  if (inner === null) return null;

  // Мобильная главная директора — ОТДЕЛЬНЫЙ экран со своей механикой
  // (мобильная главная директора на `MhScreen`, теперь удалена), а не медиазапрос над
  // пультом. Поэтому карточка обязана уметь встать и туда — но ЛОГИКОЙ она
  // одна, различается только обёртка. Второй компонент здесь был бы ровно тем
  // механизмом, из-за которого красные флаги «Присмотра» полгода не доезжали
  // до телефона (CLAUDE.md).
  if (variant === "mobile") {
    return (
      <MhSection title="Утренний брифинг">
        <div className="card-s brief-card brief-card-m">{inner}</div>
      </MhSection>
    );
  }

  return (
    <section className="card brief-card" aria-labelledby="briefing-h">
      <div className="brief-t" id="briefing-h">
        Утренний брифинг
      </div>
      {inner}
    </section>
  );
}
