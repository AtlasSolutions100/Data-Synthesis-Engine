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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccountInput, AccountUpdate, AccountInputType } from "@workspace/api-client-react";

const accountSchema = z.object({
  number: z.string().min(1, "Account number is required"),
  name: z.string().min(1, "Name is required"),
  type: z.enum([
    "income",
    "cogs",
    "expense",
    "other_income",
    "other_expense",
    "asset",
    "bank",
    "liability",
    "credit_card",
  ]),
  parentNumber: z.string().optional(),
});

type AccountFormValues = z.infer<typeof accountSchema>;

interface AccountFormProps {
  defaultValues?: Partial<AccountFormValues>;
  onSubmit: (data: AccountInput | AccountUpdate) => void;
  isLoading?: boolean;
}

export function AccountForm({ defaultValues, onSubmit, isLoading }: AccountFormProps) {
  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      number: defaultValues?.number || "",
      name: defaultValues?.name || "",
      type: defaultValues?.type || "expense",
      parentNumber: defaultValues?.parentNumber || "",
    },
  });

  const handleSubmit = (values: AccountFormValues) => {
    onSubmit({
      number: values.number,
      name: values.name,
      type: values.type as AccountInputType,
      parentNumber: values.parentNumber || null,
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="number"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Account Number</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Type</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="income">Income</SelectItem>
                    <SelectItem value="cogs">COGS</SelectItem>
                    <SelectItem value="expense">Expense</SelectItem>
                    <SelectItem value="other_income">Other Income</SelectItem>
                    <SelectItem value="other_expense">Other Expense</SelectItem>
                    <SelectItem value="asset">Asset</SelectItem>
                    <SelectItem value="bank">Bank</SelectItem>
                    <SelectItem value="liability">Liability</SelectItem>
                    <SelectItem value="credit_card">Credit Card</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="parentNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Parent Number (Optional)</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Saving..." : "Save Account"}
        </Button>
      </form>
    </Form>
  );
}
