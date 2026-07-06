---
name: FormLabel outside FormField crashes the app
description: shadcn FormLabel throws useFormField error when used as a section heading; use plain text instead
---

In the books artifact's shadcn `ui/form.tsx`, `FormLabel` calls `useFormField()` which reads `FormFieldContext`. If a `FormLabel` is used anywhere outside a `<FormField ... render={...}>` block, it throws `useFormField should be used within <FormField>` and takes down the whole page with an "Invalid hook call" React error.

**Why:** Multiple form components used `<FormLabel>` as a *section heading* (e.g. "Line Items", "Worker Lines", "Employer Burden Rates (%)") inside plain `<div>`s, not as an actual field label. This crashed the payroll, bill, and invoice forms at render time.

**How to apply:** Only use `FormLabel` inside a `FormField`/`FormItem` render. For section headings/group titles, use a plain element instead: `<p className="text-sm font-medium leading-none">…</p>`. When debugging a "useFormField should be used within <FormField>" crash, grep `FormLabel` across `artifacts/books/src/components/forms/*.tsx` and check each one is inside a FormField render, not a bare div.
