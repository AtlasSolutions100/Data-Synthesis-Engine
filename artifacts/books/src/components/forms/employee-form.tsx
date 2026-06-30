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
import { Checkbox } from "@/components/ui/checkbox";
import { parseDollars } from "@/lib/format";
import { EmployeeInput, EmployeeUpdate } from "@workspace/api-client-react";

const employeeSchema = z.object({
  name: z.string().min(1, "Name is required"),
  straightTimeRate: z.string().optional(),
  overtimeRate: z.string().optional(),
  taxExempt: z.boolean().default(false),
  active: z.boolean().default(true),
});

type EmployeeFormValues = z.infer<typeof employeeSchema>;

interface EmployeeFormProps {
  defaultValues?: Partial<EmployeeFormValues>;
  onSubmit: (data: EmployeeInput | EmployeeUpdate) => void;
  isLoading?: boolean;
}

export function EmployeeForm({ defaultValues, onSubmit, isLoading }: EmployeeFormProps) {
  const form = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeSchema),
    defaultValues: {
      name: defaultValues?.name || "",
      straightTimeRate: defaultValues?.straightTimeRate || "",
      overtimeRate: defaultValues?.overtimeRate || "",
      taxExempt: defaultValues?.taxExempt ?? false,
      active: defaultValues?.active ?? true,
    },
  });

  const handleSubmit = (values: EmployeeFormValues) => {
    onSubmit({
      name: values.name,
      straightTimeRateCents: values.straightTimeRate ? parseDollars(values.straightTimeRate) : null,
      overtimeRateCents: values.overtimeRate ? parseDollars(values.overtimeRate) : null,
      taxExempt: values.taxExempt,
      active: values.active,
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
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
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="straightTimeRate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Straight Time Rate ($/hr)</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="overtimeRate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Overtime Rate ($/hr)</FormLabel>
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
          name="taxExempt"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>Tax exempt</FormLabel>
                <p className="text-xs text-slate-500">
                  Skip employer payroll taxes (SS, Medicare, FUTA, SUI) for this
                  worker.
                </p>
              </div>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="active"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>
                  Active Employee
                </FormLabel>
              </div>
            </FormItem>
          )}
        />
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Saving..." : "Save Employee"}
        </Button>
      </form>
    </Form>
  );
}
