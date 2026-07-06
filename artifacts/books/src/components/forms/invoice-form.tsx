import { useForm, useFieldArray } from "react-hook-form";
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
import { parseDollars, formatCents } from "@/lib/format";
import { Plus, Trash2 } from "lucide-react";
import type { InvoiceInput } from "@workspace/api-client-react";

const lineSchema = z.object({
  description: z.string().optional(),
  amount: z.string().min(1, "Amount is required"),
});

const invoiceSchema = z.object({
  invoiceNumber: z.string().min(1, "Invoice number is required"),
  jobId: z.string().min(1, "Job ID is required"),
  customerId: z.string().optional(),
  date: z.string().min(1, "Date is required"),
  dueDate: z.string().optional(),
  memo: z.string().optional(),
  lines: z.array(lineSchema).min(1, "At least one line item is required"),
});

type InvoiceFormValues = z.infer<typeof invoiceSchema>;

interface InvoiceFormProps {
  defaultValues?: Partial<InvoiceFormValues>;
  onSubmit: (data: InvoiceInput) => void;
  isLoading?: boolean;
  lockJob?: boolean;
}

export function InvoiceForm({
  defaultValues,
  onSubmit,
  isLoading,
  lockJob,
}: InvoiceFormProps) {
  const form = useForm<InvoiceFormValues>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      invoiceNumber: defaultValues?.invoiceNumber || "",
      jobId: defaultValues?.jobId || "",
      customerId: defaultValues?.customerId || "",
      date: defaultValues?.date || new Date().toISOString().split("T")[0],
      dueDate: defaultValues?.dueDate || "",
      memo: defaultValues?.memo || "",
      lines: defaultValues?.lines || [{ description: "", amount: "" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  const watchedLines = form.watch("lines");
  const totalCents = (watchedLines ?? []).reduce(
    (sum, l) => sum + parseDollars(l?.amount || "0"),
    0,
  );

  const handleSubmit = (values: InvoiceFormValues) => {
    onSubmit({
      invoiceNumber: values.invoiceNumber,
      jobId: parseInt(values.jobId, 10),
      customerId: values.customerId ? parseInt(values.customerId, 10) : null,
      date: values.date,
      dueDate: values.dueDate || null,
      memo: values.memo || null,
      lines: values.lines.map((l) => ({
        description: l.description || null,
        amountCents: parseDollars(l.amount),
      })),
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="invoiceNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Invoice Number</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="jobId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Job ID</FormLabel>
                <FormControl>
                  <Input type="number" {...field} disabled={lockJob} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="customerId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Customer ID (Optional)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    placeholder="Defaults to job"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
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
            name="dueDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Due Date (Optional)</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium leading-none">Line Items</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append({ description: "", amount: "" })}
            >
              <Plus className="mr-1 h-4 w-4" /> Add Line
            </Button>
          </div>
          {fields.map((fieldItem, index) => (
            <div key={fieldItem.id} className="flex gap-2 items-start">
              <FormField
                control={form.control}
                name={`lines.${index}.description`}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormControl>
                      <Input placeholder="Description" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`lines.${index}.amount`}
                render={({ field }) => (
                  <FormItem className="w-40">
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="Amount"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-red-500 hover:text-red-700 hover:bg-red-50"
                onClick={() => fields.length > 1 && remove(index)}
                disabled={fields.length <= 1}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex justify-end pt-2 text-sm font-semibold text-slate-900">
            Total: {formatCents(totalCents)}
          </div>
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
          {isLoading ? "Saving..." : "Save Invoice"}
        </Button>
      </form>
    </Form>
  );
}
