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
import { parseDollars } from "@/lib/format";
import type { ServerFieldError } from "@/lib/server-field-error";

const creditSchema = z.object({
  date: z.string().min(1, "Date is required"),
  referenceNum: z.string().optional(),
  amount: z.string().min(1, "Amount is required"),
  memo: z.string().optional(),
});

type CreditFormValues = z.infer<typeof creditSchema>;

export interface VendorCreditSubmit {
  date: string;
  referenceNum: string | null;
  amountCents: number;
  memo: string | null;
}

const SERVER_FIELD_MAP: Record<string, FieldPath<CreditFormValues>> = {
  date: "date",
  referenceNum: "referenceNum",
  amountCents: "amount",
  memo: "memo",
};

interface VendorCreditFormProps {
  defaultAmount?: string;
  onSubmit: (data: VendorCreditSubmit) => void;
  isLoading?: boolean;
  serverError?: ServerFieldError | null;
}

export function VendorCreditForm({
  defaultAmount,
  onSubmit,
  isLoading,
  serverError,
}: VendorCreditFormProps) {
  const form = useForm<CreditFormValues>({
    resolver: zodResolver(creditSchema),
    defaultValues: {
      date: new Date().toISOString().split("T")[0],
      referenceNum: "",
      amount: defaultAmount || "",
      memo: "",
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

  const handleSubmit = (values: CreditFormValues) => {
    onSubmit({
      date: values.date,
      referenceNum: values.referenceNum || null,
      amountCents: parseDollars(values.amount),
      memo: values.memo || null,
    });
  };

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
            data-testid="text-credit-server-error"
          >
            {formLevelError.message}
          </p>
        ) : null}
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Recording..." : "Record Credit"}
        </Button>
      </form>
    </Form>
  );
}
