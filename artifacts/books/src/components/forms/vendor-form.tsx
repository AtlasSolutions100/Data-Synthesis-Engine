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
import {
  VendorInput,
  VendorUpdate,
  checkVendorDuplicates,
  type VendorDuplicateCandidate,
} from "@workspace/api-client-react";
import { DuplicateWarningDialog } from "@/components/forms/duplicate-warning-dialog";

const vendorSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email").or(z.literal("")),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

type VendorFormValues = z.infer<typeof vendorSchema>;

interface VendorFormProps {
  defaultValues?: Partial<VendorFormValues>;
  onSubmit: (data: VendorInput | VendorUpdate) => void;
  isLoading?: boolean;
}

export function VendorForm({ defaultValues, onSubmit, isLoading }: VendorFormProps) {
  const form = useForm<VendorFormValues>({
    resolver: zodResolver(vendorSchema),
    defaultValues: {
      name: defaultValues?.name || "",
      email: defaultValues?.email || "",
      phone: defaultValues?.phone || "",
      notes: defaultValues?.notes || "",
    },
  });

  // Duplicate-check state: hold the built payload until user confirms or cancels.
  const [pendingPayload, setPendingPayload] = useState<VendorInput | VendorUpdate | null>(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState<VendorDuplicateCandidate[]>([]);

  const buildPayload = (values: VendorFormValues): VendorInput | VendorUpdate => ({
    name: values.name,
    email: values.email || null,
    phone: values.phone || null,
    notes: values.notes || null,
  });

  const handleSubmit = async (values: VendorFormValues) => {
    const payload = buildPayload(values);

    // Only check for duplicates in create mode (no existing name in defaultValues).
    if (!defaultValues?.name) {
      try {
        const candidates = await checkVendorDuplicates({ name: values.name });
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
        entityLabel="vendor"
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
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email (Optional)</FormLabel>
                  <FormControl>
                    <Input type="email" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone (Optional)</FormLabel>
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
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Notes (Optional)</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" disabled={isLoading} className="w-full">
            {isLoading ? "Saving..." : "Save Vendor"}
          </Button>
        </form>
      </Form>
    </>
  );
}
