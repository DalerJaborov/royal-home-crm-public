import type { ReactNode } from "react";
import { Document, Image, Page, Rect, Line, StyleSheet, Svg, Text, View, G } from "@react-pdf/renderer";
import { C, deltaPercent, ensureReportFonts, num, reportLogos } from "./theme.js";

/**
 * НАБОР ДЕТАЛЕЙ PDF-ОТЧЁТА: обложка, страница с шапкой и подвалом, плитки
 * с главными цифрами, таблица, графики. Отчёты (financeDocument, teamDocument)
 * собираются только из этих деталей — так все PDF выглядят одной семьёй.
 */
ensureReportFonts();

const PAGE_X = 40;
export const CONTENT_WIDTH = 595.28 - PAGE_X * 2;

const s = StyleSheet.create({
  cover: { fontFamily: "Onest", backgroundColor: C.white },
  coverBand: { backgroundColor: C.accent, height: 520, paddingHorizontal: 56, paddingTop: 64, position: "relative" },
  coverGlow: { position: "absolute", right: -120, top: -80, width: 360, height: 360, borderRadius: 180, backgroundColor: "#2a6cf0" },
  coverGlow2: { position: "absolute", right: 40, top: 300, width: 180, height: 180, borderRadius: 90, backgroundColor: "#1854cc" },
  coverLogo: { width: 92, height: 116 },
  coverKicker: { color: "#cfe0ff", fontSize: 10, fontWeight: 600, letterSpacing: 2, marginTop: 70, textTransform: "uppercase" },
  coverTitle: { color: C.white, fontSize: 36, fontWeight: 800, marginTop: 10, lineHeight: 1.15 },
  coverPeriod: { color: C.white, fontSize: 18, fontWeight: 500, marginTop: 14, opacity: 0.92 },
  coverBody: { paddingHorizontal: 56, paddingTop: 44 },
  coverMetaRow: { flexDirection: "row", marginBottom: 18 },
  coverMetaLabel: { width: 130, fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1, paddingTop: 2 },
  coverMetaValue: { flex: 1, fontSize: 12, color: C.ink, fontWeight: 500 },
  coverFoot: { position: "absolute", bottom: 40, left: 56, right: 56, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 12, flexDirection: "row", justifyContent: "space-between" },
  coverFootText: { fontSize: 8.5, color: C.muted },
  page: { fontFamily: "Onest", fontSize: 9.5, color: C.text, paddingTop: 78, paddingBottom: 64, paddingHorizontal: PAGE_X, backgroundColor: C.white },
  header: { position: "absolute", top: 26, left: PAGE_X, right: PAGE_X, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: C.line, paddingBottom: 10 },
  headerLogo: { width: 20, height: 25, marginRight: 9 },
  headerBrand: { fontSize: 9, fontWeight: 800, color: C.ink, letterSpacing: 1.5 },
  headerTitle: { fontSize: 9, color: C.muted, marginLeft: 8 },
  headerPeriod: { marginLeft: "auto", fontSize: 9, color: C.accent, fontWeight: 600 },
  footer: { position: "absolute", bottom: 26, left: PAGE_X, right: PAGE_X, flexDirection: "row", justifyContent: "space-between", fontSize: 8, color: C.muted },
  section: { marginBottom: 22 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 3 },
  sectionHint: { fontSize: 8.5, color: C.muted, marginBottom: 10, lineHeight: 1.4 },
  sectionBar: { width: 22, height: 3, backgroundColor: C.accent, borderRadius: 2, marginBottom: 7 },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -5 },
  kpi: { width: "50%", paddingHorizontal: 5, marginBottom: 10 },
  kpiCard: { backgroundColor: C.accentSoft, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, minHeight: 74 },
  kpiCardMain: { backgroundColor: C.accent },
  kpiLabel: { fontSize: 8.5, color: C.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.6 },
  kpiValue: { fontSize: 20, fontWeight: 800, color: C.ink, marginTop: 6 },
  kpiHint: { fontSize: 8, color: C.muted, marginTop: 4 },
  chip: { fontSize: 8, fontWeight: 600, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8, marginTop: 6, alignSelf: "flex-start" },
  table: { borderRadius: 8, borderWidth: 1, borderColor: C.line },
  th: { flexDirection: "row", backgroundColor: C.zebra, borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 7, paddingHorizontal: 8 },
  thText: { fontSize: 7.5, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  tr: { flexDirection: "row", paddingVertical: 6.5, paddingHorizontal: 8, borderBottomWidth: 0.6, borderBottomColor: C.line },
  trZebra: { backgroundColor: "#fbfcfe" },
  td: { fontSize: 9, color: C.text },
  totals: { flexDirection: "row", paddingVertical: 8, paddingHorizontal: 8, backgroundColor: C.accentSoft, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
  totalsText: { fontSize: 9, fontWeight: 700, color: C.ink },
  note: { fontSize: 8, color: C.muted, marginTop: 6, lineHeight: 1.4 },
  empty: { fontSize: 9, color: C.muted, paddingVertical: 14, paddingHorizontal: 12, backgroundColor: C.zebra, borderRadius: 8 },
  legend: { flexDirection: "row", marginTop: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", marginRight: 14 },
  legendDot: { width: 8, height: 8, borderRadius: 2, marginRight: 5 },
  legendText: { fontSize: 8, color: C.muted },
});

export interface ReportShell {
  title: string;
  /** Заголовок обложки с явным переносом строки: движок иногда рвёт длинное слово посередине. */
  coverTitle?: string;
  periodLabel: string;
  /** Кто сформировал — имя сотрудника или «CRM, по расписанию». */
  preparedBy: string;
  generatedAtLabel: string;
  children: ReactNode;
}

/** Документ целиком: обложка + страницы отчёта с шапкой, подвалом и номерами. */
export function ReportDocument({ title, coverTitle, periodLabel, preparedBy, generatedAtLabel, children }: ReportShell) {
  return (
    <Document title={`${title} — ${periodLabel}`} author="Royal Home CRM" subject={title} creator="Royal Home CRM" producer="Royal Home CRM" language="ru">
      <Page size="A4" style={s.cover}>
        <View style={s.coverBand}>
          <View style={s.coverGlow} />
          <View style={s.coverGlow2} />
          <Image src={reportLogos().white} style={s.coverLogo} />
          <Text style={s.coverKicker}>Royal Home · отчёт для руководства</Text>
          <Text style={s.coverTitle}>{coverTitle ?? title}</Text>
          <Text style={s.coverPeriod}>{periodLabel}</Text>
        </View>
        <View style={s.coverBody}>
          <View style={s.coverMetaRow}>
            <Text style={s.coverMetaLabel}>Подготовлено</Text>
            <Text style={s.coverMetaValue}>{preparedBy}</Text>
          </View>
          <View style={s.coverMetaRow}>
            <Text style={s.coverMetaLabel}>Сформирован</Text>
            <Text style={s.coverMetaValue}>{generatedAtLabel} (время Душанбе)</Text>
          </View>
          <View style={s.coverMetaRow}>
            <Text style={s.coverMetaLabel}>Источник</Text>
            <Text style={s.coverMetaValue}>Записи CRM Royal Home. Цифры те же, что на экране, вручную не правились.</Text>
          </View>
        </View>
        <View style={s.coverFoot}>
          <Text style={s.coverFootText}>Конфиденциально · только для сотрудников Royal Home</Text>
          <Text style={s.coverFootText}>royalhome.tj</Text>
        </View>
      </Page>
      <Page size="A4" style={s.page} wrap>
        <View style={s.header} fixed>
          <Image src={reportLogos().green} style={s.headerLogo} />
          <Text style={s.headerBrand}>ROYAL HOME</Text>
          <Text style={s.headerTitle}>· {title}</Text>
          <Text style={s.headerPeriod}>{periodLabel}</Text>
        </View>
        {children}
        <View style={s.footer} fixed>
          <Text>Конфиденциально · сформирован {generatedAtLabel}</Text>
          <Text render={({ pageNumber, totalPages }) => `Страница ${pageNumber} из ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** lead — первый блок раздела (график, плитки), который не отрывается от заголовка на другую страницу. */
export function Section({ title, hint, lead, children, breakBefore }: { title: string; hint?: string; lead?: ReactNode; children?: ReactNode; breakBefore?: boolean }) {
  return (
    <View style={s.section} break={breakBefore}>
      {/* Заголовок не остаётся сиротой внизу страницы без своей таблицы. */}
      <View wrap={false} minPresenceAhead={200}>
        <View style={s.sectionBar} />
        <Text style={s.sectionTitle}>{title}</Text>
        {hint ? <Text style={s.sectionHint}>{hint}</Text> : <View style={{ height: 8 }} />}
        {lead}
      </View>
      {children}
    </View>
  );
}

export interface Kpi {
  label: string;
  value: string;
  hint?: string;
  /** Для плашки изменения: текущее и прошлое значения. */
  current?: number;
  previous?: number | null;
  /** Рост — это хорошо (доход) или плохо (расходы). */
  upIsGood?: boolean;
  main?: boolean;
}

function DeltaChip({ current, previous, upIsGood = true, onAccent }: { current: number; previous: number | null | undefined; upIsGood?: boolean; onAccent?: boolean }) {
  const d = deltaPercent(current, previous);
  if (d === null) return <Text style={[s.chip, { color: onAccent ? "#dbe7ff" : C.muted, backgroundColor: onAccent ? "#3b74e6" : C.white }]}>нет прошлого месяца для сравнения</Text>;
  const good = d === 0 ? null : (d > 0) === upIsGood;
  const color = onAccent ? C.white : good === null ? C.muted : good ? C.good : C.bad;
  const bg = onAccent ? "#3b74e6" : good === null ? C.white : good ? C.goodSoft : C.badSoft;
  // Знак словом-символом, а не стрелкой: в Onest нет ▲▼, и просмотрщик подставлял чужой шрифт.
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  return <Text style={[s.chip, { color, backgroundColor: bg }]}>{`${sign}${Math.abs(Math.round(d))} % к прошлому месяцу`}</Text>;
}

export function KpiGrid({ items }: { items: Kpi[] }) {
  return (
    <View style={s.kpiGrid} wrap={false}>
      {items.map((k) => (
        <View key={k.label} style={s.kpi}>
          <View style={[s.kpiCard, k.main ? s.kpiCardMain : {}]}>
            <Text style={[s.kpiLabel, k.main ? { color: "#d5e3ff" } : {}]}>{k.label}</Text>
            <Text style={[s.kpiValue, k.main ? { color: C.white } : {}]}>{k.value}</Text>
            {k.current !== undefined ? <DeltaChip current={k.current} previous={k.previous} upIsGood={k.upIsGood} onAccent={k.main} /> : null}
            {k.hint ? <Text style={[s.kpiHint, k.main ? { color: "#d5e3ff" } : {}]}>{k.hint}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

export interface Column {
  title: string;
  /** Доля ширины (flex). */
  flex: number;
  align?: "left" | "right";
}

/** Таблица с шапкой, повторяемой на каждой новой странице, и строкой итогов. */
export function DataTable({ columns, rows, totals, note, emptyText }: { columns: Column[]; rows: string[][]; totals?: string[]; note?: string; emptyText?: string }) {
  if (rows.length === 0) return <Text style={s.empty}>{emptyText ?? "За этот период записей нет."}</Text>;
  const cell = (c: Column) => ({ flex: c.flex, textAlign: c.align ?? "left" }) as const;
  return (
    <View>
      <View style={s.table}>
        <View style={s.th} fixed>
          {columns.map((c) => <Text key={c.title} style={[s.thText, cell(c)]}>{c.title}</Text>)}
        </View>
        {rows.map((r, i) => (
          <View key={i} style={[s.tr, i % 2 === 1 ? s.trZebra : {}]} wrap={false}>
            {r.map((v, j) => <Text key={j} style={[s.td, cell(columns[j]!), j === 0 ? { color: C.ink, fontWeight: 500 } : {}]}>{v}</Text>)}
          </View>
        ))}
        {totals ? (
          <View style={s.totals} wrap={false}>
            {totals.map((v, j) => <Text key={j} style={[s.totalsText, cell(columns[j]!)]}>{v}</Text>)}
          </View>
        ) : null}
      </View>
      {note ? <Text style={s.note}>{note}</Text> : null}
    </View>
  );
}

export interface Series {
  name: string;
  color: string;
  values: number[];
}

/** Столбики по месяцам: несколько рядов рядом, сетка и подписи. Отрицательное — вниз от нуля. */
export function BarChart({ labels, series, height = 170 }: { labels: string[]; series: Series[]; height?: number }) {
  const width = CONTENT_WIDTH;
  const padL = 46;
  const padB = 18;
  const plotW = width - padL;
  const plotH = height - padB - 6;
  const all = series.flatMap((x) => x.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const y = (v: number) => 6 + ((max - v) / span) * plotH;
  const groupW = plotW / Math.max(labels.length, 1);
  const barW = Math.min(18, (groupW * 0.7) / Math.max(series.length, 1));
  const ticks = [max, max - span / 2, min].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <View wrap={false}>
      <Svg width={width} height={height}>
        {ticks.map((t) => (
          <G key={t}>
            <Line x1={padL} x2={width} y1={y(t)} y2={y(t)} stroke={C.line} strokeWidth={0.7} />
            <Text x={padL - 6} y={y(t) + 3} style={{ fontFamily: "Onest", fontSize: 7, fill: C.muted }} textAnchor="end">{num(t)}</Text>
          </G>
        ))}
        <Line x1={padL} x2={width} y1={y(0)} y2={y(0)} stroke={C.gray} strokeWidth={0.9} />
        {labels.map((label, i) => {
          const gx = padL + i * groupW + (groupW - barW * series.length) / 2;
          return (
            <G key={label + i}>
              {series.map((ser, k) => {
                const v = ser.values[i] ?? 0;
                const top = Math.min(y(v), y(0));
                const h = Math.max(Math.abs(y(v) - y(0)), v === 0 ? 0 : 1);
                return <Rect key={ser.name} x={gx + k * barW} y={top} width={barW - 2} height={h} fill={ser.color} rx={2} />;
              })}
              <Text x={padL + i * groupW + groupW / 2} y={height - 4} style={{ fontFamily: "Onest", fontSize: 7.5, fill: C.muted }} textAnchor="middle">{label}</Text>
            </G>
          );
        })}
      </Svg>
      <View style={s.legend}>
        {series.map((ser) => (
          <View key={ser.name} style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: ser.color }]} />
            <Text style={s.legendText}>{ser.name}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Горизонтальные полосы «название — сумма» (расходы по статьям, источники). */
export function BarList({ items, color = C.accent, format = num }: { items: { label: string; value: number }[]; color?: string; format?: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <View>
      {items.map((item) => (
        <View key={item.label} style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }} wrap={false}>
          <Text style={{ width: 150, fontSize: 9, color: C.text }}>{item.label}</Text>
          <View style={{ flex: 1, height: 9, backgroundColor: C.zebra, borderRadius: 5, marginRight: 8 }}>
            <View style={{ width: `${Math.max(1.5, (item.value / max) * 100)}%`, height: 9, backgroundColor: color, borderRadius: 5 }} />
          </View>
          <Text style={{ width: 82, fontSize: 9, textAlign: "right", fontWeight: 600, color: C.ink }}>{format(item.value)}</Text>
        </View>
      ))}
    </View>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <Text style={s.note}>{children}</Text>;
}

/** Воронка: полосы по шагам. Без «% от шага выше»: шаги — события по своим датам, а не одни и те же клиенты (как и на экране «Отчёты»). */
export function Funnel({ steps }: { steps: { label: string; count: number; extra?: string }[] }) {
  const max = Math.max(1, ...steps.map((x) => x.count));
  return (
    <View wrap={false}>
      {steps.map((step, i) => {
        return (
          <View key={step.label} style={{ flexDirection: "row", alignItems: "center", marginBottom: 7 }}>
            <Text style={{ width: 92, fontSize: 9, color: C.text }}>{step.label}</Text>
            <View style={{ flex: 1 }}>
              <View style={{ width: `${Math.max(3, (step.count / max) * 100)}%`, backgroundColor: i === steps.length - 1 ? C.accentDeep : C.accent, opacity: 1 - i * 0.1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 }}>
                <Text style={{ fontSize: 10, fontWeight: 700, color: C.white }}>{num(step.count)}</Text>
              </View>
            </View>
            {step.extra ? <Text style={{ width: 120, fontSize: 8, color: C.muted, textAlign: "right" }}>{step.extra}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}
