import { z } from "zod";
import { CLIENT_SOURCES, EXPENSE_CATEGORIES } from "./enums.js";
export const expenseDateSchema = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/).refine((v) => { const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; }, "Некорректная дата");
export const EXPENSE_PAYMENT_METHODS = ["CASH", "CARD", "BANK", "CARD_DIRECTOR"] as const;
export const EXPENSE_PERIODS = ["WEEK", "MONTH", "QUARTER", "YEAR"] as const;
export const EXPENSE_SORT_KEYS = ["date","title","category","counterparty","method","author","amount"] as const;
export type ExpenseSortKey = typeof EXPENSE_SORT_KEYS[number];
export const EXPENSE_METHOD_LABELS = {CASH:"Наличные",CARD:"Карта компании",BANK:"Расчётный счёт",CARD_DIRECTOR:"Карта директора"} as const;
export const expenseWorkspaceFields = {
    status: z.enum(["PLANNED", "PAID"]).optional(),
    paymentDate: expenseDateSchema.nullish(),
    counterparty: z.string().trim().max(200).nullish(),
    paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).nullish(),
    categoryId: z.uuid().nullish(),
    currency: z.enum(["TJS", "USD"]).optional(),
    exchangeRate: z.number().positive().max(1000).nullish(),
};
export const expenseCategorySchema = z.object({
    title: z.string().trim().min(1).max(100), rootCategory: z.enum(EXPENSE_CATEGORIES),
    parentId: z.uuid().nullish(), icon: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,40}$/),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/), budgetMonthly: z.number().min(0).max(99999999.99).nullish(), active: z.boolean().optional(),
}).strict();
export const recurringWorkspaceFields = {
    period: z.enum(EXPENSE_PERIODS).optional(), startsOn: expenseDateSchema.nullish(), endsOn: expenseDateSchema.nullish(),
    autoPay: z.boolean().optional(), categoryId: expenseWorkspaceFields.categoryId,
    counterparty: expenseWorkspaceFields.counterparty, paymentMethod: expenseWorkspaceFields.paymentMethod,
};
export const recurringOccurrenceSchema = z.object({ dueDate: expenseDateSchema, paymentDate: expenseDateSchema.optional() }).strict();
export const expensePaymentSchema = z.object({ paymentDate: expenseDateSchema.optional() }).strict();
export const expenseListQuerySchema = z.object({
    sortBy:z.enum(EXPENSE_SORT_KEYS).optional(),
    sortDirection:z.enum(["asc","desc"]).default("desc"),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), from: expenseDateSchema.optional(), to: expenseDateSchema.optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(), pageSize: z.coerce.number().int().min(1).max(200).default(50),
    categoryId: z.uuid().optional(), rootCategory: z.enum(EXPENSE_CATEGORIES).optional(), counterparty: z.string().max(200).optional(),
    recurringId: z.uuid().optional(),
    paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).optional(), status: z.enum(["PLANNED", "PAID"]).optional(), q: z.string().max(200).optional(),
}).refine((v) => !v.from || !v.to || v.from <= v.to, "Начало периода позже конца");
export interface ExpenseCategoryItem {
    id: string;
    title: string;
    rootCategory: typeof EXPENSE_CATEGORIES[number];
    parentId: string | null;
    icon: string;
    color: string;
    budgetMonthly: string | null;
    active: boolean;
    usageCount?: number;
    spentTjs?: number;
}
export interface ExpenseUpcomingItem {
    id: string;
    expenseId?: string;
    recurringId?: string;
    dueDate: string;
    status: "PLANNED" | "PAID" | "SKIPPED";
    title: string;
    amount: string;
    currency: "TJS" | "USD";
    category: typeof EXPENSE_CATEGORIES[number];
    categoryId: string | null;
    counterparty: string | null;
    paymentMethod: typeof EXPENSE_PAYMENT_METHODS[number] | null;
}
export interface ExpenseReceiptItem {
    id: string;
    originalName: string;
    mimeType: string;
    size: number;
    url: string;
}
export interface ExpensePivot {
    months: string[];
    rows: {
        categoryId: string;
        title: string;
        rootCategory: typeof EXPENSE_CATEGORIES[number];
        color: string;
        values: Record<string, number>;
    }[];
    totalTjs: number;
}
export type ExpenseWorkspaceInput = z.infer<typeof expensePaymentSchema>;
export type ExpenseSource = typeof CLIENT_SOURCES[number];
