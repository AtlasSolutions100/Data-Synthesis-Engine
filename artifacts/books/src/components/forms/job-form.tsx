import { useState } from "react";
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
  checkJobDuplicates,
  type JobDuplicateCandidate,
} from "@workspace/api-client-react";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { DuplicateWarningDialog } from "@/components/forms/duplicate-warning-dialog";

const jobSchema = z.object({
  name: z.string().min(1, "Job name is required"),
  poNumber: z.string().optional(),
  customerId: z.string().min(1, "Customer is required"),
  description: z.string().optional(),
  status: z.enum(["active", "completed", "on_hold", "inactive"]),
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

  // Duplicate-check state: hold the built payload until user confirms or cancels.
  const [pendingPayload, setPendingPayload] = useState<JobInput | JobUpdate | null>(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState<JobDuplicateCandidate[]>([]);

  const buildPayload = (values: JobFormValues): JobInput | JobUpdate => ({
    name: values.name,
    poNumber: values.poNumber || null,
    customerId: values.customerId ? parseInt(values.customerId, 10) : null,
    isInternal: false,
    description: values.description || null,
    status: values.status as JobInputStatus,
    contractAmountCents: values.contractAmount ? parseDollars(values.contractAmount) : 0,
  });

  const handleSubmit = async (values: JobFormValues) => {
    const payload = buildPayload(values);

    // Check for duplicates in create mode, or in edit mode when the name changed.
    if (!defaultValues?.name || values.name !== defaultValues.name) {
      try {
        const candidates = await checkJobDuplicates({ name: values.name });
        if (candidates.length > 0) {
          setDuplicateCandidates(candidates);
          setPendingPayload(payload);
          return; // Wait for user to confirm or cancel in the dialog.
        }
      } catch {
        // If the check fails (e.g. network error), proceed with saving anyway
        // so the duplicate check never blocks the save.
      }
    }

    onSubmit(payload);
  };

  const handleDuplicateConfirm = () => {
    if (pendingPayload) {
      onSubmit(pendingPayload);
    }
    setDuplicateCandidates([]);
    setPendingPayload(null);
  };

  const handleDuplicateCancel = () => {
    setDuplicateCandidates([]);
    setPendingPayload(null);
  };

  return (
    <>
      <DuplicateWarningDialog
        open={duplicateCandidates.length > 0}
        entityLabel="job"
        candidates={duplicateCandidates}
        onConfirm={handleDuplicateConfirm}
        onCancel={handleDuplicateCancel}
      />
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
                  <FormLabel>PO Number (Optional)</FormLabel>
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
                  <FormLabel>Customer</FormLabel>
                  <FormControl>
                    <EntityCombobox
                      options={(customers ?? []).map((c) => ({ id: c.id, label: c.name }))}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      placeholder="Select customer"
                      searchPlaceholder="Search customers..."
                      emptyText="No customers found."
                      disabled={false}
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
                      {field.value === "inactive" ? (
                        // Inactive is flipped from the job detail page (admin
                        // only); shown here just so an inactive job's other
                        // fields can be edited without changing its status.
                        <SelectItem value="inactive" disabled>
                          Inactive (change on job page)
                        </SelectItem>
                      ) : null}
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
    </>
  );
}
