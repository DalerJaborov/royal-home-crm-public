import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Подтверждение действий со сделкой — одно на оба облика доски (десктоп
 * pages/Deals.tsx и мобильный components/mobile/MobileDeals.tsx).
 *
 * Вынесено отдельно, потому что текст здесь — не украшение, а описание
 * последствий: двум копиям такого текста нельзя позволить разойтись при
 * первой же правке правил.
 *
 * Цена и комиссия суммой (19.08.2026) вводятся отдельной формой при отправке
 * на закрытие — см. DealSubmitModal. Здесь, в "approve"/"reject", уже нечего
 * вводить: директор одобряет или отклоняет цифры, которые указал агент.
 */
export function DealStageConfirm({
  action,
  onConfirm,
  onCancel,
}: {
  action: "cancel" | "approve" | "reject";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const config = {
    cancel: {
      title: "Отменить сделку?",
      description: "Объект вернётся в продажу (если по нему нет других сделок), клиент вернётся в работу. Отменить действие нельзя.",
      confirmLabel: "Отменить сделку",
      danger: true,
    },
    approve: {
      title: "Одобрить закрытие сделки?",
      description: "Объект станет «Продано», деньги, указанные агентом, зафиксируются в отчётах и Финансах. Отменить действие нельзя.",
      confirmLabel: "Одобрить",
      danger: false,
    },
    reject: {
      title: "Отправить на доработку?",
      description: "Сделка вернётся на этап «Договор подписан», агент сможет поправить цену или комиссию и отправить снова.",
      confirmLabel: "Отправить на доработку",
      danger: false,
    },
  }[action];

  return (
    <ConfirmDialog
      title={config.title}
      description={config.description}
      confirmLabel={config.confirmLabel}
      danger={config.danger}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
