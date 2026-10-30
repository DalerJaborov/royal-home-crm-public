# Recurring expense day validation

Manual QA reproduced a legacy expense sheet changing an entered day 31 to 28 without telling the user. The Clean wizard already rejects unsupported days. The legacy sheet now uses the same `prepareCleanExpense` request builder for both one-off and recurring expenses, preserves the entered value, shows the supported 1–28 range and blocks invalid submission. Decimal commas follow the same monetary rules in both forms.

Six UI regressions failed before the change. Afterward, 43 focused tests passed, including invalid days, unchanged valid day 28, decimal amounts, shell routing and existing expense guards. Manual stand verification confirmed day 31 remains visible with saving disabled and day 28 enables saving. No external payment or notification was initiated; the synthetic recurring template used to reproduce the original issue was disabled.
