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
import { parseDollars } from "@/lib/format";
import {
  JobInput,
  JobUpdate,
  JobInputStatus,
  useListCustomers,
  getListCustomersQueryKey,
} from "@workspace/api-client-react";
import { EntityCombobox } from "@/components/forms/entity-combobox";

const jobSchema = z.object({
  name: z.string().min(1, "Job name is required"),
  poNumber: z.string().optional(),
  customerId: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["active", "completed", "on_hold"]),
  contractAmount: z.string().optional(),
});

type JobFormValues = z.infer<typeof jobSchema>;

interface JobFormProps {
  defaultValues?: Partial<JobFormValues>;
  onSubmit: (data: JobInput | JobUpdate) => void;
  isLoading?: boolean;
}

export function JobForm({ defaultValues, onSubmit, isLoading }: JobFormProps) {
  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });

  const form = useForm<JobFormValues>({
    resolver: zodResolver(jobSchema),
    defaultValues: {
      name: defaultValues?.name || "",
      poNumber: defaultValues?.poNumber || "",
      customerId: defaultValues?.customerId || "",
      description: defaultValues?.description || "",
      status: defaultValues?.status || "active",
      contractAmount: defaultValues?.contractAmount || "",
    },
  });

  const handleSubmit = (values: JobFormValues) => {
    onSubmit({
      name: values.name,
      poNumber: values.poNumber || null,
      customerId: values.customerId ? parseInt(values.customerId, 10) : null,
      description: values.description || null,
      status: values.status as JobInputStatus,
      contractAmountCents: values.contractAmount ? parseDollars(values.contractAmount) : 0,
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
              <FormLabel>Job Name</FormLabel>
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
            name="poNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>PO Number</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="customerId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Customer (Optional)</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={(customers ?? []).map((c) => ({ id: c.id, label: c.name }))}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Select customer"
                    searchPlaceholder="Search customers..."
                    emptyText="No customers found."
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="on_hold">On Hold</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="contractAmount"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Contract Amount ($)</FormLabel>
              <FormControl>
                <Input type="number" step="0.01" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description (Optional)</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Saving..." : "Save Job"}
        </Button>
      </form>
    </Form>
  );
}
