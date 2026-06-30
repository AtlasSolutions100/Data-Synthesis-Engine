import { useForm } from "react-hook-form";
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

const paymentSchema = z.object({
  date: z.string().min(1, "Date is required"),
  method: z.enum(["check", "cash", "ach", "credit_card", "other"]),
  referenceNum: z.string().optional(),
  amount: z.string().min(1, "Amount is required"),
  memo: z.string().optional(),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;

export interface PaymentSubmit {
  date: string;
  method: "check" | "cash" | "ach" | "credit_card" | "other";
  referenceNum: string | null;
  amountCents: number;
  memo: string | null;
}

interface PaymentFormProps {
  defaultAmount?: string;
  onSubmit: (data: PaymentSubmit) => void;
  isLoading?: boolean;
}

export function PaymentForm({
  defaultAmount,
  onSubmit,
  isLoading,
}: PaymentFormProps) {
  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      date: new Date().toISOString().split("T")[0],
      method: "check",
      referenceNum: "",
      amount: defaultAmount || "",
      memo: "",
    },
  });

  const handleSubmit = (values: PaymentFormValues) => {
    onSubmit({
      date: values.date,
      method: values.method,
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
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Recording..." : "Record Payment"}
        </Button>
      </form>
    </Form>
  );
}
