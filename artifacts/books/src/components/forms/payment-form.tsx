import { useEffect } from "react";
import { useForm } from "react-hook-form";
import type { FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseDollars } from "@/lib/format";
import type { ServerFieldError } from "@/lib/server-field-error";

const paymentSchema = z.object({
  date: z.string().min(1, "Date is required"),
  method: z.enum(["check", "cash", "ach", "credit_card", "other"]),
  referenceNum: z.string().optional(),
  amount: z.string().min(1, "Amount is required"),
  memo: z.string().optional(),
  bankAccountId: z.string().optional(),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;

export interface PaymentSubmit {
  date: string;
  method: "check" | "cash" | "ach" | "credit_card" | "other";
  referenceNum: string | null;
  amountCents: number;
  memo: string | null;
  bankAccountId?: number | null;
}

export interface PaymentBankAccountOption {
  id: number;
  number: string;
  name: string;
}

const SERVER_FIELD_MAP: Record<string, FieldPath<PaymentFormValues>> = {
  date: "date",
  method: "method",
  referenceNum: "referenceNum",
  amountCents: "amount",
  memo: "memo",
  bankAccountId: "bankAccountId",
};

interface PaymentFormProps {
  defaultAmount?: string;
  onSubmit: (data: PaymentSubmit) => void;
  isLoading?: boolean;
  serverError?: ServerFieldError | null;
  /**
   * Bank accounts the payment can be drawn from. When provided (bill
   * payments), non-card payments require a selection and post a withdrawal
   * to that account's register. Omit for flows without register posting
   * (e.g. invoice/customer payments).
   */
  bankAccounts?: PaymentBankAccountOption[];
}

export function PaymentForm({
  defaultAmount,
  onSubmit,
  isLoading,
  serverError,
  bankAccounts,
}: PaymentFormProps) {
  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      date: new Date().toISOString().split("T")[0],
      method: "check",
      referenceNum: "",
      amount: defaultAmount || "",
      memo: "",
      bankAccountId:
        bankAccounts && bankAccounts.length > 0 ? String(bankAccounts[0].id) : "",
    },
  });

  const mappedField =
    serverError?.field != null ? SERVER_FIELD_MAP[serverError.field] : undefined;
  const fieldError = mappedField ? serverError : null;
  const formLevelError = serverError && !fieldError ? serverError : null;

  useEffect(() => {
    if (!fieldError || !mappedField) return;
    form.setError(mappedField, {
      type: "server",
      message: fieldError.message,
    });
  }, [fieldError, mappedField, form]);

  const hasBankAccounts = (bankAccounts?.length ?? 0) > 0;

  const handleSubmit = (values: PaymentFormValues) => {
    if (
      hasBankAccounts &&
      values.method !== "credit_card" &&
      !values.bankAccountId
    ) {
      form.setError("bankAccountId", {
        type: "required",
        message: "Choose which bank account this payment is drawn from",
      });
      return;
    }
    onSubmit({
      date: values.date,
      method: values.method,
      referenceNum: values.referenceNum || null,
      amountCents: parseDollars(values.amount),
      memo: values.memo || null,
      bankAccountId:
        hasBankAccounts && values.method !== "credit_card" && values.bankAccountId
          ? Number(values.bankAccountId)
          : null,
    });
  };

  const method = form.watch("method");

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Amount ($)</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="method"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Method</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select method" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="check">Check</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="ach">ACH</SelectItem>
                    <SelectItem value="credit_card">Credit Card</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="referenceNum"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Reference Num (Optional)</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        {hasBankAccounts && method !== "credit_card" && (
          <FormField
            control={form.control}
            name="bankAccountId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Pay From Account</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger data-testid="select-payment-bank-account">
                      <SelectValue placeholder="Select bank account" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {bankAccounts!.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.number} · {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <FormField
          control={form.control}
          name="memo"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Memo (Optional)</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {formLevelError ? (
          <p
            role="alert"
            className="text-sm font-medium text-destructive"
            data-testid="text-payment-server-error"
          >
            {formLevelError.message}
          </p>
        ) : null}
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Recording..." : "Record Payment"}
        </Button>
      </form>
    </Form>
  );
}
