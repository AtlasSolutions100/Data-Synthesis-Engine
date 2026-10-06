import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAccounts,
  getListAccountsQueryKey,
  useListVendors,
  getListVendorsQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useReadStatement,
  usePrepareStatementImport,
  useImportStatement,
  useCreateStatementAccount,
  useEnsureVendorReconcileAccount,
  getListTransactionsQueryKey,
  getListBillsQueryKey,
  type StatementImportLine,
  type StatementReadResult,
  type StatementCommitResult,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { JobCombobox } from "@/components/job-combobox";
import { formatCents, formatDate } from "@/lib/format";
import { toServerFieldError } from "@/lib/server-field-error";
import { CheckCircle2, FileUp, Loader2, Upload, ArrowLeftRight } from "lucide-react";

/**
 * Import a statement (client meeting 2026-10-06). Mike is catching the books
 * up from January: he drops in or pastes a bank, credit card or vendor
 * statement, the app works out whose it is and where each line belongs, and
 * what he approves goes into the books. No reconciling here — that's a
 * separate step he does month by month afterwards.
 */

const BALANCE_SHEET = new Set(["asset", "bank", "liability", "credit_card"]);
const P_AND_L = new Set(["income", "expense", "cogs", "other_expense"]);
const MAX_FILE_MB = 10;

type Row = StatementImportLine & {
  key: number;
  include: boolean;
  existingTransactionId: number | null;
  /** Category account id, or a negative id for "money moved from/to that account". */
  category: string;
  vendorId: string;
  jobId: string;
};

const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });

export default function StatementImport() {
  const queryClient = useQueryClient();
  const { data: accounts } = useListAccounts({ query: { queryKey: getListAccountsQueryKey() } });
  const { data: vendors } = useListVendors({ query: { queryKey: getListVendorsQueryKey() } });
  const { data: jobs } = useListJobs(undefined, { query: { queryKey: getListJobsQueryKey() } });
  const read = useReadStatement();
  const prepare = usePrepareStatementImport();
  const commit = useImportStatement();
  const createAccount = useCreateStatementAccount();
  const ensureVendorAccount = useEnsureVendorReconcileAccount();

  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState<StatementReadResult | null>(null);
  const [accountId, setAccountId] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [statementVendorId, setStatementVendorId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"credit_card" | "bank" | "liability">("credit_card");
  const [bulkCategory, setBulkCategory] = useState("");
  const [done, setDone] = useState<StatementCommitResult | null>(null);

  const statementAccounts = useMemo(
    () => (accounts ?? []).filter((a) => BALANCE_SHEET.has(a.type)),
    [accounts],
  );
  const account = statementAccounts.find((a) => String(a.id) === accountId);
  // Categories, plus "money moved from/to another of my accounts" as negative ids.
  const categoryOptions = useMemo(
    () => [
      ...(accounts ?? []).filter((a) => P_AND_L.has(a.type)).map((a) => ({ id: a.id, label: `${a.number} — ${a.name}` })),
      ...statementAccounts
        .filter((a) => String(a.id) !== accountId)
        .map((a) => ({ id: -a.id, label: `Moved from/to ${a.name} (not an expense)` })),
    ],
    [accounts, statementAccounts, accountId],
  );
  const vendorOptions = useMemo(() => (vendors ?? []).map((v) => ({ id: v.id, label: v.name })), [vendors]);

  const startOver = () => {
    setText("");
    setFile(null);
    setResult(null);
    setAccountId("");
    setRows([]);
    setStatementVendorId(null);
    setDone(null);
    setError(null);
    setBulkCategory("");
  };

  const doRead = async () => {
    setError(null);
    if (!file && !text.trim()) {
      setError("Drop a statement file or paste the statement text first.");
      return;
    }
    if (file && file.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`That file is too large. Keep it under ${MAX_FILE_MB} MB.`);
      return;
    }
    try {
      const r = await read.mutateAsync({
        data: {
          text: text.trim() || null,
          fileData: file ? await readFile(file) : null,
          fileName: file?.name ?? null,
        },
      });
      setResult(r);
      setRows(
        r.lines.map((l, i) => ({
          ...l,
          key: i,
          include: true,
          existingTransactionId: null,
          category: "",
          vendorId: "",
          jobId: "",
        })),
      );
      setNewName(r.detectedName ?? "");
      setNewType(r.detectedKind === "bank" ? "bank" : r.detectedKind === "vendor" ? "liability" : "credit_card");
      setAccountId(r.detectedAccountId != null ? String(r.detectedAccountId) : "");
    } catch (err) {
      setError(toServerFieldError(err, "Couldn't read that statement. Please try again.").message);
    }
  };

  // Once the account is known: what's already in the books, and where the rest goes.
  const preparedFor = useRef<string>("");
  useEffect(() => {
    if (!accountId || rows.length === 0 || preparedFor.current === accountId) return;
    preparedFor.current = accountId;
    prepare
      .mutateAsync({
        data: {
          accountId: Number(accountId),
          lines: rows.map(({ date, description, amountCents, direction }) => ({ date, description, amountCents, direction })),
        },
      })
      .then((p) => {
        setStatementVendorId(p.vendorId ?? null);
        setRows((prev) =>
          prev.map((r, i) => {
            const s = p.lines[i];
            if (!s) return r;
            const existing = s.existingTransactionId ?? null;
            return {
              ...r,
              existingTransactionId: existing,
              include: existing == null,
              category: r.category || (s.suggestedAccountId != null ? String(s.suggestedAccountId) : ""),
              vendorId: r.vendorId || (s.suggestedVendorId != null ? String(s.suggestedVendorId) : ""),
            };
          }),
        );
      })
      .catch((err) => setError(toServerFieldError(err, "Couldn't check those lines against the books.").message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, rows.length]);

  const setRow = (key: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const makeAccount = async () => {
    setError(null);
    try {
      const vendorMatch =
        result?.detectedVendorId != null && newType === "liability"
          ? await ensureVendorAccount.mutateAsync({ id: result.detectedVendorId })
          : null;
      const created = vendorMatch ?? (await createAccount.mutateAsync({ data: { name: newName.trim(), type: newType } }));
      await queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      preparedFor.current = "";
      setAccountId(String(created.accountId));
    } catch (err) {
      setError(toServerFieldError(err, "Couldn't set up that account.").message);
    }
  };

  const chosen = rows.filter((r) => r.include);
  const ready = chosen.filter((r) => r.category);
  const needCategory = chosen.length - ready.length;
  const alreadyIn = rows.filter((r) => r.existingTransactionId != null).length;
  const asBills = statementVendorId != null;

  const doImport = async () => {
    setError(null);
    if (ready.length === 0) {
      setError("Pick a category for at least one line.");
      return;
    }
    try {
      const out = await commit.mutateAsync({
        data: {
          accountId: Number(accountId),
          lines: ready.map((r) => {
            const cat = Number(r.category);
            const bill = asBills && r.direction === "out" && cat > 0;
            return {
              date: r.date,
              description: r.description,
              amountCents: r.amountCents,
              direction: r.direction,
              categoryAccountId: cat > 0 ? cat : null,
              transferAccountId: cat < 0 ? -cat : null,
              vendorId: bill ? statementVendorId : r.vendorId ? Number(r.vendorId) : null,
              jobId: r.jobId ? Number(r.jobId) : null,
              asBill: bill,
            };
          }),
        },
      });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["getAccountBalanceTransactions"] });
      // Lines left without a category stay on screen to finish.
      const importedKeys = new Set(ready.map((r) => r.key));
      const left = rows.filter((r) => r.include && !importedKeys.has(r.key));
      setDone(out);
      setRows(left);
    } catch (err) {
      setError(toServerFieldError(err, "Couldn't enter those lines. Nothing was saved.").message);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Import a Statement</h1>
        <p className="mt-1 text-muted-foreground">
          Drop in a bank, credit card or vendor statement to get its lines into the books. This doesn't reconcile
          anything; you can do that later.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {done && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5" data-testid="statement-import-done">
            <div className="flex items-start gap-2 text-sm text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
              <span>
                Entered into the books:{" "}
                {[
                  done.transactionsCreated ? `${done.transactionsCreated} entr${done.transactionsCreated === 1 ? "y" : "ies"}` : "",
                  done.billsCreated ? `${done.billsCreated} bill${done.billsCreated === 1 ? "" : "s"}` : "",
                  done.transfersCreated ? `${done.transfersCreated} transfer${done.transfersCreated === 1 ? "" : "s"}` : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
                {account ? ` on ${account.name}` : ""}.
                {rows.length > 0 ? ` ${rows.length} line${rows.length === 1 ? "" : "s"} still need a category below.` : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {account && (
                <Link href={`/accounts/${account.id}/register`} className="text-sm text-blue-700 hover:underline">
                  Open {account.name}
                </Link>
              )}
              <Button variant="outline" onClick={startOver} data-testid="button-import-another">
                Import another statement
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!result ? (
        <Card>
          <CardContent className="space-y-4 p-5">
            <div
              className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center ${
                dragOver ? "border-blue-500 bg-blue-50" : "border-slate-300 hover:bg-slate-50"
              }`}
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
              data-testid="drop-zone-statement-import"
            >
              <FileUp className="h-7 w-7 text-slate-400" />
              <p className="text-sm font-medium text-slate-700">
                {file ? file.name : "Drop the statement here, or click to choose a file"}
              </p>
              <p className="text-xs text-slate-500">PDF, CSV, Excel, or a photo</p>
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept=".pdf,.csv,.xlsx,image/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="statement-text">Or paste the statement</Label>
              <Textarea
                id="statement-text"
                rows={6}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Copy the whole statement and paste it here. You don't have to say who it's from."
                data-testid="textarea-statement-import"
              />
            </div>
            <Button onClick={() => void doRead()} disabled={read.isPending} data-testid="button-read-statement">
              {read.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {read.isPending ? "Reading the statement…" : "Read statement"}
            </Button>
          </CardContent>
        </Card>
      ) : rows.length === 0 && done ? null : (
        <>
          <Card>
            <CardContent className="space-y-3 p-5">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[260px] flex-1 space-y-1">
                  <Label>This statement is for</Label>
                  <EntityCombobox
                    options={statementAccounts.map((a) => ({ id: a.id, label: `${a.number} — ${a.name}` }))}
                    value={accountId}
                    onChange={(v) => {
                      preparedFor.current = "";
                      setAccountId(v ?? "");
                    }}
                    placeholder="Pick the bank, card or vendor account"
                    searchPlaceholder="Search accounts..."
                    emptyText="No accounts found."
                    clearable={false}
                    data-testid="select-statement-import-account"
                  />
                </div>
                <Button variant="ghost" onClick={startOver}>
                  Start over
                </Button>
              </div>
              {account ? (
                <p className="text-sm text-slate-600" data-testid="text-statement-detected">
                  {result.detectedAccountId === account.id
                    ? `Recognized as ${account.name}.`
                    : `Using ${account.name}.`}{" "}
                  {asBills ? "Charges will be entered as bills for this vendor." : ""}
                </p>
              ) : (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3" data-testid="statement-new-account">
                  <p className="text-sm font-medium text-amber-900">
                    {result.detectedName
                      ? `This looks like a statement from ${result.detectedName}, which isn't an account in your books yet.`
                      : "Couldn't tell who this statement is from."}{" "}
                    Pick the account above, or add it:
                  </p>
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="new-acct-name">Account name</Label>
                      <Input id="new-acct-name" className="w-64" value={newName} onChange={(e) => setNewName(e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label>Kind</Label>
                      <Select value={newType} onValueChange={(v) => setNewType(v as typeof newType)}>
                        <SelectTrigger className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="credit_card">Credit card</SelectItem>
                          <SelectItem value="bank">Bank account</SelectItem>
                          <SelectItem value="liability">Vendor account</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      onClick={() => void makeAccount()}
                      disabled={!newName.trim() || createAccount.isPending || ensureVendorAccount.isPending}
                      data-testid="button-create-statement-account"
                    >
                      Add this account
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {account && (
            <Card>
              <CardContent className="space-y-3 p-0">
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
                  <p className="text-sm text-slate-700" data-testid="text-statement-import-summary">
                    {prepare.isPending
                      ? "Checking these lines against your books…"
                      : `${chosen.length} to enter · ${alreadyIn} already in the books${needCategory ? ` · ${needCategory} need a category` : ""}`}
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="w-64">
                      <EntityCombobox
                        options={categoryOptions}
                        value={bulkCategory}
                        onChange={(v) => setBulkCategory(v ?? "")}
                        placeholder="Category for the blank ones"
                        searchPlaceholder="Search categories..."
                        emptyText="No categories found."
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!bulkCategory || needCategory === 0}
                      onClick={() => setRows((prev) => prev.map((r) => (r.include && !r.category ? { ...r, category: bulkCategory } : r)))}
                    >
                      Fill blanks
                    </Button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-y bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                        <th className="w-10 px-3 py-2"></th>
                        <th className="w-24 px-2 py-2">Date</th>
                        <th className="px-2 py-2">Description</th>
                        <th className="w-28 px-2 py-2 text-right">Amount</th>
                        <th className="w-64 px-2 py-2">Category</th>
                        {!asBills && <th className="w-48 px-2 py-2">Vendor</th>}
                        <th className="w-56 px-2 py-2">Job</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr
                          key={r.key}
                          className={`border-b last:border-0 ${r.include ? "" : "bg-slate-50 text-slate-400"}`}
                          data-testid={`statement-row-${r.key}`}
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-blue-600"
                              checked={r.include}
                              onChange={() => setRow(r.key, { include: !r.include })}
                              aria-label={`Enter ${r.description || "this line"}`}
                            />
                          </td>
                          <td className="whitespace-nowrap px-2 py-2">{formatDate(r.date)}</td>
                          <td className="px-2 py-2">
                            {r.description || "—"}
                            {r.existingTransactionId != null && (
                              <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">
                                Already in the books
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              className={`inline-flex items-center gap-1 tabular-nums ${r.direction === "in" ? "text-emerald-700" : "text-slate-900"}`}
                              title="Click to switch between money spent and money back"
                              onClick={() => setRow(r.key, { direction: r.direction === "out" ? "in" : "out" })}
                              data-testid={`button-flip-${r.key}`}
                            >
                              {r.direction === "in" ? "+" : ""}
                              {formatCents(r.amountCents)}
                              <ArrowLeftRight className="h-3 w-3 text-slate-400" />
                            </button>
                          </td>
                          <td className="px-2 py-1.5">
                            {r.include && (
                              <EntityCombobox
                                options={categoryOptions}
                                value={r.category}
                                onChange={(v) => setRow(r.key, { category: v ?? "" })}
                                placeholder="Pick a category"
                                searchPlaceholder="Search categories..."
                                emptyText="No categories found."
                              />
                            )}
                          </td>
                          {!asBills && (
                            <td className="px-2 py-1.5">
                              {r.include && (
                                <EntityCombobox
                                  options={vendorOptions}
                                  value={r.vendorId}
                                  onChange={(v) => setRow(r.key, { vendorId: v ?? "" })}
                                  placeholder="Vendor (optional)"
                                  searchPlaceholder="Search vendors..."
                                  emptyText="No vendors found."
                                />
                              )}
                            </td>
                          )}
                          <td className="px-2 py-1.5">
                            {r.include && (
                              <JobCombobox
                                jobs={jobs ?? []}
                                value={r.jobId}
                                onChange={(v) => setRow(r.key, { jobId: v })}
                                placeholder="Job (optional)"
                                allowCreate
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
                  <p className="text-xs text-slate-500">
                    Green amounts are money back (payments, refunds, deposits). Click an amount to switch it.
                    {needCategory > 0 ? " Lines with no category stay here until you pick one." : ""}
                  </p>
                  <Button
                    onClick={() => void doImport()}
                    disabled={commit.isPending || prepare.isPending || ready.length === 0}
                    className="bg-emerald-600 hover:bg-emerald-700"
                    data-testid="button-import-statement"
                  >
                    {commit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Enter {ready.length} line{ready.length === 1 ? "" : "s"} into the books
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
