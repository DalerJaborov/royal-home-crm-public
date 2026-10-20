import { Sparkles } from "lucide-react";
import { Button, Rh2Sheet } from "../../rh2";
import { HomeAsk } from "../HomeAsk";

/**
 * ПОМОЩНИК ПОД ЗНАЧКОМ «ИИ» (контракт 06.10.2026): с первого экрана убраны
 * предисловие «слушаю ваши звонки», абзац-доклад, «Заметил N» и поле вопроса
 * с готовыми вопросами. Остался один круглый значок; он открывает шторку с
 * тем же полем и теми же двумя подсказками. Запрос прежний, `POST /ai/assistant`
 * (`HomeAsk`): сервер сам режет ответ по роли, агенту закрыты чужие карточки.
 */
export function AiButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="icon" aria-label="Спросить помощника (ИИ)" title="Спросить помощника" onClick={onClick}>
      <Sparkles className="i" aria-hidden="true" width={20} height={20} />
    </Button>
  );
}

export function AgentAskSheet({ onClose }: { onClose: () => void }) {
  return (
    <Rh2Sheet title="Спросить помощника" onClose={onClose}>
      <HomeAsk
        nested
        ariaLabel="Вопрос про моих клиентов"
        placeholder="Кто из моих клиентов ближе к сделке?"
        suggestions={["Кто из моих клиентов ближе всего к сделке?", "Кого я давно не набирал?"]}
      />
    </Rh2Sheet>
  );
}
