import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { formatMoney } from "../../lib/format";

/**
 * График комиссии за 12 месяцев вынесен из pages/PultClean.tsx отдельным файлом:
 * recharts — единственный потребитель тяжёлой библиотеки на экране, и пульт
 * подгружает этот файл лениво (см. CleanCommissionChartLazy), чтобы код графика
 * не тормозил первый показ цифр. Вид графика не менялся.
 */
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function monthShort(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return MONTHS[m - 1] ?? ym;
}

export type CommissionChartMonth = { month: string; amountTjs: number };

export default function CleanCommissionChart({ months }: { months: CommissionChartMonth[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={months.map((m) => ({
          m: monthShort(m.month),
          v: Math.round(m.amountTjs),
        }))}
        margin={{ top: 10, right: 4, left: 4, bottom: 0 }}
      >
        <defs>
          <linearGradient id="cleanArea" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--rgb-accent))" stopOpacity={0.28} />
            <stop offset="100%" stopColor="rgb(var(--rgb-accent))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="m"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 13, fill: "rgb(var(--rgb-g500))" }}
          interval="preserveStartEnd"
        />
        <Tooltip
          cursor={{
            stroke: "rgb(var(--rgb-accent))",
            strokeDasharray: "3 3",
          }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="rounded-[10px] border border-line-soft bg-card px-3 py-1.5 text-[13px] font-semibold shadow-md">
                {label} ·{" "}
                {formatMoney(Number(payload[0].value), "TJS")}
              </div>
            ) : null
          }
        />
        <Area
          type="monotone"
          dataKey="v"
          stroke="rgb(var(--rgb-accent))"
          strokeWidth={2.5}
          fill="url(#cleanArea)"
          isAnimationActive={false}
          animationDuration={1400}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
