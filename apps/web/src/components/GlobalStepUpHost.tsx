import { useEffect, useState } from "react";
import { globalStepUpNeeded } from "../lib/stepUpOwners";
import { useAuthStore } from "../store/auth";
import { toast } from "../store/toast";
import { StepUpDialog } from "./StepUpDialog";

/**
 * Общее окно подтверждения личности: открывается на отказ сервера 428 там, где
 * экран не обрабатывает его сам (см. lib/stepUpOwners.ts).
 */
export function GlobalStepUpHost() {
  const agent = useAuthStore((s) => s.agent);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onRequired = () => {
      if (globalStepUpNeeded()) setOpen(true);
    };
    window.addEventListener("step-up-required", onRequired);
    return () => window.removeEventListener("step-up-required", onRequired);
  }, []);

  if (!open || !agent) return null;
  return (
    <StepUpDialog
      description="Это действие требует подтверждения. После подтверждения нажмите кнопку ещё раз."
      onConfirmed={() => {
        setOpen(false);
        toast.success("Подтверждено. Нажмите кнопку ещё раз.");
      }}
      onCancel={() => setOpen(false)}
    />
  );
}
