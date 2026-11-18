/**
 * Сумма нового вида: число не рвётся переносом посередине («1 234 567,50» — одним
 * куском, `white-space: nowrap` в слое), перенос допустим только перед валютой
 * («с.», «$»). Строка приходит уже отформатированной (`nums`/`claudeMoney`) —
 * здесь она только делится на «число» и «валюту», текст не меняется ни на знак.
 */
export function splitAmount(text: string): [number: string, tail: string] {
  const match = /^(.*?)(\s(?:с\.|с|сомони|\$))$/.exec(text);
  return match ? [match[1], match[2]] : [text, ""];
}

export function RoyalAmount({ text, className }: { text: string; className?: string }) {
  const [number, tail] = splitAmount(text);
  return (
    <span className={className ? `ry-amount ${className}` : "ry-amount"}>
      <span className="ry-amount-num">{number}</span>{tail}
    </span>
  );
}
