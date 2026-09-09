/**
 * Design preview entry (`preview.html`). Renders real pages inside the real
 * Layout with canned API data so the visual system can be reviewed in a
 * browser without a database or a Clerk session:
 *
 *   VITE_PREVIEW=1 PORT=18855 BASE_PATH=/ pnpm --filter @workspace/books run dev
 *   → http://localhost:18855/preview.html#/dashboard
 *
 * Routes mirror the app's. Data is deliberately realistic for this client
 * (job names, vendors, amounts in the range Mike works with) so hierarchy
 * and column widths are judged against the real thing, not lorem ipsum.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, Route, Switch, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import "../index.css";
import { Layout } from "@/components/layout";
import { Toaster } from "@/components/ui/toaster";
import Dashboard from "@/pages/dashboard";
import Jobs from "@/pages/jobs";
import Bills from "@/pages/bills";
import Vendors from "@/pages/vendors";
import VendorDetail from "@/pages/vendor-detail";
import AccountRegister from "@/pages/account-register";
import Accounts from "@/pages/accounts";
import InboxPage from "@/pages/inbox";
import Invoices from "@/pages/invoices";
import Customers from "@/pages/customers";

// ── Canned data ──────────────────────────────────────────────────────────
const customers = [
  { id: 1, name: "Douglas County School District", email: "ap@dcsd.org", phone: null, address: null, ccEmail: null, notes: null, isDemo: false, jobCount: 3 },
  { id: 2, name: "Rose Medical Center", email: null, phone: "303-555-0142", address: null, ccEmail: null, notes: null, isDemo: false, jobCount: 3 },
  { id: 3, name: "Bassett Construction", email: null, phone: null, address: null, ccEmail: null, notes: null, isDemo: false, jobCount: 2 },
  { id: 4, name: "Allied 2026", email: null, phone: null, address: null, ccEmail: null, notes: "Internal overhead", isDemo: false, jobCount: 1 },
];

const job = (id: number, name: string, customerId: number, contract: number, income: number, cost: number, extra: Record<string, unknown> = {}) => ({
  id, jobNumber: `JOB-${1000 + id}`, name, poNumber: extra.poNumber ?? null, customerId,
  customerName: customers.find((c) => c.id === customerId)?.name ?? null, isDemo: false,
  description: null, status: extra.status ?? "active", inactiveNote: null,
  contractAmountCents: contract, incomeCents: income, costCents: cost, profitCents: income - cost,
  remainingCents: contract - cost, billedToDateCents: income, remainingContractCents: contract - income,
  overUnderBillingCents: income - cost, invoiceCount: extra.invoiceCount ?? 2, lastInvoicedDate: "2026-08-28",
  aliases: extra.aliases ?? [],
});
const jobs = [
  job(11, "HR Stadium", 1, 18_450_000, 12_200_000, 9_874_512, { poNumber: "PO-88214" }),
  job(12, "Larkspur Gear", 1, 6_200_000, 6_200_000, 4_113_209, { status: "completed", invoiceCount: 4 }),
  job(13, "Bruce Randolph", 1, 9_800_000, 3_100_000, 2_988_120, { poNumber: "PO-88301" }),
  job(21, "Rose Parking Garage", 2, 24_000_000, 8_000_000, 7_240_000, { aliases: ["Founders", "Rose add-on"] }),
  job(22, "Rachel", 2, 4_300_000, 4_300_000, 3_902_441, { aliases: ["Ritual"] }),
  job(23, "Rose Annex Lighting", 2, 1_750_000, 0, 212_400, { invoiceCount: 0 }),
  job(31, "Ritual Coffee Buildout", 3, 3_900_000, 1_950_000, 1_401_887),
  job(32, "Warehouse Lighting", 3, 2_250_000, 2_250_000, 2_311_000, { status: "completed" }),
  job(41, "Overhead / Office 2026", 4, 0, 0, 1_842_300),
];

const vendors = [
  { id: 1, name: "CED", email: "ar@ced.com", phone: "303-555-0199", notes: null, isDemo: false },
  { id: 2, name: "Home Depot", email: null, phone: null, notes: "Pro Xtra account", isDemo: false },
  { id: 3, name: "City Electric Supply", email: null, phone: null, notes: null, isDemo: false },
  { id: 4, name: "Eduardo Concrete", email: null, phone: "720-555-0107", notes: null, isDemo: false },
  { id: 5, name: "Hybrid Payroll", email: null, phone: null, notes: null, isDemo: false },
];

const bill = (id: number, vendorId: number, jobId: number | null, number: string, date: string, due: string, total: number, paid: number) => ({
  id, billNumber: number, isDemo: false, vendorId, vendorName: vendors.find((v) => v.id === vendorId)!.name,
  jobId, jobNumber: jobId ? `JOB-${1000 + jobId}` : null, jobName: jobs.find((j) => j.id === jobId)?.name ?? null,
  date, dueDate: due, memo: null, totalCents: total, paidCents: paid, balanceCents: total - paid,
  status: paid >= total ? "paid" : paid > 0 ? "partial" : "open", documentPath: null, postedToLedger: true,
  linkedTransactionCount: 2, lines: [], payments: [], credits: [],
});
const bills = [
  bill(101, 1, 13, "55021", "2026-08-04", "2026-09-03", 24_909, 0),
  bill(102, 1, 21, "55088", "2026-08-11", "2026-09-10", 187_450, 0),
  bill(103, 1, 22, "55142", "2026-08-19", "2026-09-18", 92_033, 0),
  bill(104, 1, 21, "55199", "2026-08-27", "2026-09-26", 310_000, 0),
  bill(105, 2, 11, "HD-2026-0812", "2026-08-12", "2026-09-11", 382_230, 382_230),
  bill(106, 3, 11, "CES-77102", "2026-08-15", "2026-09-14", 1_284_600, 500_000),
  bill(107, 4, 31, "INV-14", "2026-08-20", "2026-09-19", 2_150_000, 0),
  bill(108, 2, 13, "HD-2026-0829", "2026-08-29", "2026-09-28", 64_812, 0),
];

const accounts = [
  { id: 1, number: "10000", name: "Checking", type: "bank", parentNumber: null },
  { id: 2, number: "10200", name: "Savings", type: "bank", parentNumber: null },
  { id: 3, number: "11000", name: "Accounts Receivable", type: "accounts_receivable", parentNumber: null },
  { id: 4, number: "20000", name: "Accounts Payable", type: "accounts_payable", parentNumber: null },
  { id: 5, number: "21100", name: "Home Depot", type: "credit_card", parentNumber: null },
  { id: 6, number: "21200", name: "CED", type: "liability", parentNumber: null },
  { id: 7, number: "40000", name: "Contract Income", type: "income", parentNumber: null },
  { id: 8, number: "50000", name: "Job Materials", type: "cogs", parentNumber: null },
  { id: 9, number: "53600", name: "Field Labor", type: "cogs", parentNumber: null },
  { id: 10, number: "60100", name: "Fuel", type: "expense", parentNumber: null },
  { id: 11, number: "66500", name: "Payroll Processing Fees", type: "expense", parentNumber: null },
];

const line = (id: number, date: string, type: string, num: string | null, party: string, desc: string | null, other: string | null, effect: number, extra: Record<string, unknown> = {}) => ({
  transactionId: id, date, type, num, partyName: party, description: desc, role: effect < 0 && type !== "payroll" ? "primary" : "split",
  otherAccountName: other, effectCents: effect, amountCents: Math.abs(effect), voidedAmountCents: null,
  clearedStatus: extra.cleared ?? "uncleared", vendorPaymentId: null, payrollRunId: null, jobName: null, ...extra,
});
const registerLines = [
  line(901, "2026-08-01", "deposit", null, "Douglas County School District", "Invoice 2026-041 · HR Stadium", "Accounts Receivable", 4_250_000, { cleared: "cleared" }),
  line(902, "2026-08-05", "check", "1041", "Eduardo Concrete", "Payment — INV-13", "CED", -1_850_000, { cleared: "cleared" }),
  line(903, "2026-08-12", "payroll", "PR-18", "Brendan", "Payroll 2026-08-03 – 2026-08-09", "Field Labor", -244_800, { payrollRunId: 18, jobName: "Rose Parking Garage" }),
  line(904, "2026-08-12", "payroll", "PR-18", "Brendan", "Payroll 2026-08-03 – 2026-08-09", "Field Labor", -163_200, { payrollRunId: 18, jobName: "Rachel" }),
  line(905, "2026-08-12", "payroll", "PR-18", "Michael", "Payroll 2026-08-03 – 2026-08-09", "Field Labor", -512_000, { payrollRunId: 18, jobName: "HR Stadium" }),
  line(906, "2026-08-12", "payroll", "PR-18", "Payroll processing fee", "Payroll service fee 2026-08-03 – 2026-08-09", "Payroll Processing Fees", -7_200, { payrollRunId: 18 }),
  line(907, "2026-08-18", "check", "1042", "CED", "Payment — 4 bills (55021, 55088, 55142, 55199)", "CED", -614_392, {
    vendorPaymentId: 7, checkItems: [
      { billId: 101, billNumber: "55021", jobName: "Bruce Randolph", amountCents: 24_909 },
      { billId: 102, billNumber: "55088", jobName: "Rose Parking Garage", amountCents: 187_450 },
      { billId: 103, billNumber: "55142", jobName: "Rachel", amountCents: 92_033 },
      { billId: 104, billNumber: "55199", jobName: "Rose Parking Garage", amountCents: 310_000 },
    ],
  }),
  line(908, "2026-08-22", "deposit", null, "Rose Medical Center", "Invoice 2026-044 · Rose Parking Garage", "Accounts Receivable", 3_100_000),
  line(909, "2026-08-29", "check", "To Print", "Home Depot", "Payment — HD-2026-0812", "Home Depot", -382_230),
  line(910, "2026-09-12", "check", null, "Hybrid Payroll", "Payroll 2026-09-07 – 2026-09-13 (scheduled)", "Field Labor", -1_584_212),
];
const runningBalance = registerLines.reduce((s, l) => s + l.effectCents, 0);

const inbox = [
  { id: 1, fromAddress: "ar@ced.com", fromName: "CED Billing", subject: "Invoice 55231 - Rose Parking Garage", receivedAt: "2026-09-09T13:12:00Z", textBody: "Please find invoice 55231 attached. Amount due $1,204.18.", attachments: [{ fileName: "invoice-55231.pdf", contentType: "application/pdf", sizeBytes: 184_320 }], kind: "bill", status: "new", note: null, processedAt: null },
  { id: 2, fromAddress: "brendan@gmail.com", fromName: "Brendan", subject: "Fwd: hours week 36", receivedAt: "2026-09-08T22:41:00Z", textBody: "Mon 8/31 Founders 5 hrs, Ritual 4 hrs\nTue 9/1 Founders 9 hrs\nWed 9/2 HR Stadium 8 hrs\nThu 9/3 HR Stadium 8 hrs\nFri 9/4 Founders 6 hrs", attachments: [], kind: "timecard", status: "new", note: null, processedAt: null },
  { id: 3, fromAddress: "no-reply@chase.com", fromName: "Chase", subject: "Your August statement is ready", receivedAt: "2026-09-02T09:05:00Z", textBody: "Your August statement is attached.", attachments: [{ fileName: "Chase August.pdf", contentType: "application/pdf", sizeBytes: 402_118 }], kind: "statement", status: "new", note: null, processedAt: null },
];

const invoices = [
  { id: 1, invoiceNumber: "2026-041", jobId: 11, jobName: "HR Stadium", customerId: 1, customerName: "Douglas County School District", date: "2026-07-28", dueDate: "2026-08-27", totalCents: 4_250_000, paidCents: 4_250_000, balanceCents: 0, creditCents: 0, status: "paid", isDemo: false, lines: [], payments: [] },
  { id: 2, invoiceNumber: "2026-044", jobId: 21, jobName: "Rose Parking Garage", customerId: 2, customerName: "Rose Medical Center", date: "2026-08-15", dueDate: "2026-09-14", totalCents: 3_100_000, paidCents: 3_100_000, balanceCents: 0, creditCents: 0, status: "paid", isDemo: false, lines: [], payments: [] },
  { id: 3, invoiceNumber: "2026-047", jobId: 13, jobName: "Bruce Randolph", customerId: 1, customerName: "Douglas County School District", date: "2026-08-30", dueDate: "2026-09-29", totalCents: 1_980_000, paidCents: 900_000, balanceCents: 1_080_000, creditCents: 0, status: "partial", isDemo: false, lines: [], payments: [] },
  { id: 4, invoiceNumber: "2026-048", jobId: 31, jobName: "Ritual Coffee Buildout", customerId: 3, customerName: "Bassett Construction", date: "2026-09-05", dueDate: "2026-10-05", totalCents: 1_950_000, paidCents: 0, balanceCents: 1_950_000, creditCents: 0, status: "open", isDemo: false, lines: [], payments: [] },
];

const summary = {
  totalIncomeCents: 37_950_000, totalCogsCents: 23_889_000, grossProfitCents: 14_061_000,
  totalExpensesCents: 3_142_600, netIncomeCents: 10_918_400, jobCount: 9, openJobCount: 7, transactionCount: 412,
  topJobs: [], recentTransactions: [
    { id: 910, date: "2026-09-08", type: "bill", num: "55231", partyName: "CED", description: "Conduit & fittings · Rose Parking Garage", amountCents: 120_418 },
    { id: 909, date: "2026-09-05", type: "invoice", num: "2026-048", partyName: "Bassett Construction", description: "Ritual Coffee Buildout — progress billing 2", amountCents: 1_950_000 },
    { id: 907, date: "2026-08-18", type: "check", num: "1042", partyName: "CED", description: "Payment — 4 bills", amountCents: -614_392 },
    { id: 905, date: "2026-08-12", type: "payroll", num: "PR-18", partyName: "Michael", description: "Payroll 08/03 – 08/09", amountCents: 512_000 },
    { id: 901, date: "2026-08-01", type: "deposit", num: null, partyName: "Douglas County School District", description: "Invoice 2026-041 · HR Stadium", amountCents: 4_250_000 },
  ],
};

// ── Fetch mock ───────────────────────────────────────────────────────────
const routes: Array<[RegExp, (m: RegExpMatchArray, url: URL) => unknown]> = [
  [/^\/api\/users\/me$/, () => ({ id: 1, clerkUserId: "user_preview", email: "mike@alliedpowerservices.com", name: "Mike Allied", role: "owner" })],
  [/^\/api\/feedback\/count/, () => ({ count: 2 })],
  [/^\/api\/feedback\/my-updates/, () => ({ count: 0 })],
  [/^\/api\/inbound-emails$/, (_m, url) => (url.searchParams.get("status") === "all" ? inbox : inbox.filter((e) => e.status === (url.searchParams.get("status") ?? "new")))],
  [/^\/api\/reports\/dashboard/, () => summary],
  [/^\/api\/customers$/, () => customers],
  [/^\/api\/jobs$/, (_m, url) => { const c = url.searchParams.get("customerId"); return c ? jobs.filter((j) => String(j.customerId) === c) : jobs.filter((j) => url.searchParams.get("includeInactive") === "true" || j.status !== "inactive"); }],
  [/^\/api\/vendors$/, () => vendors],
  [/^\/api\/vendors\/(\d+)$/, (m) => vendors.find((v) => v.id === Number(m[1]))],
  [/^\/api\/bills$/, (_m, url) => { const v = url.searchParams.get("vendorId"); return v ? bills.filter((b) => String(b.vendorId) === v) : bills; }],
  [/^\/api\/bills\/unlinked/, () => []],
  [/^\/api\/transactions\/unlinked-bills/, () => []],
  [/^\/api\/transactions\/legacy-splits/, () => []],
  [/^\/api\/accounts$/, () => accounts],
  [/^\/api\/reports\/account-balances\/(\d+)\/transactions/, (m) => ({ accountId: Number(m[1]), accountNumber: "10000", accountName: "Checking", type: "bank", balanceCents: runningBalance, lines: registerLines })],
  [/^\/api\/reports\/account-balances/, () => ({ rows: accounts.filter((a) => ["bank", "credit_card", "liability", "accounts_receivable", "accounts_payable"].includes(a.type)).map((a) => ({ accountId: a.id, accountNumber: a.number, accountName: a.name, type: a.type, balanceCents: a.id === 1 ? runningBalance : a.id === 2 ? 2_579 : a.id === 6 ? 120_418 : 0 })) })],
  [/^\/api\/invoices$/, () => invoices],
  [/^\/api\/demo\/status/, () => ({ loaded: false, counts: {} })],
];

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.origin);
  if (url.pathname.startsWith("/api/")) {
    for (const [re, handler] of routes) {
      const m = url.pathname.match(re);
      if (m) {
        const body = handler(m, url);
        return new Response(JSON.stringify(body ?? null), { status: body === undefined ? 404 : 200, headers: { "Content-Type": "application/json" } });
      }
    }
    console.warn("[preview] unmocked", init?.method ?? "GET", url.pathname + url.search);
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(input, init);
};

// ── App ──────────────────────────────────────────────────────────────────
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

function Preview() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Layout>
          <Switch>
            <Route path="/dashboard" component={Dashboard} />
            <Route path="/customers" component={Customers} />
            <Route path="/jobs" component={Jobs} />
            <Route path="/invoices" component={Invoices} />
            <Route path="/bills" component={Bills} />
            <Route path="/vendors" component={Vendors} />
            <Route path="/vendors/:id" component={VendorDetail} />
            <Route path="/accounts" component={Accounts} />
            <Route path="/accounts/:id/register" component={AccountRegister} />
            <Route path="/inbox" component={InboxPage} />
            <Route><Redirect to="/dashboard" /></Route>
          </Switch>
        </Layout>
        <Toaster />
      </Router>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
