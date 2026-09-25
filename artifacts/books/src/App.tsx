import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { useEffect, useRef, useState } from "react";
import NotFound from "@/pages/not-found";

import Home from "./pages/home";
import Dashboard from "./pages/dashboard";
import Jobs from "./pages/jobs";
import JobDetail from "./pages/job-detail";
import Transactions from "./pages/transactions";
import Invoices from "./pages/invoices";
import InvoiceDetail from "./pages/invoice-detail";
import Bills from "./pages/bills";
import BillDetail from "./pages/bill-detail";
import Accounts from "./pages/accounts";
import AccountRegister from "./pages/account-register";
import AccountReconcileList from "./pages/account-reconcile-list";
import AccountReconcile from "./pages/account-reconcile";
import Customers from "./pages/customers";
import CustomerDetail from "./pages/customer-detail";
import Vendors from "./pages/vendors";
import VendorDetail from "./pages/vendor-detail";
import Employees from "./pages/employees";
import EmployeeDetail from "./pages/employee-detail";
import Payroll from "./pages/payroll";
import PayrollDetail from "./pages/payroll-detail";
import InboxPage from "./pages/inbox";
import ChecksToPrint from "./pages/checks-to-print";
import Reports from "./pages/reports";
import ReportPnl from "./pages/report-pnl";
import ReportBalanceSheet from "./pages/report-balance-sheet";
import ReportCosts from "./pages/report-costs";
import ReportArAging from "./pages/report-ar-aging";
import ReportApAging from "./pages/report-ap-aging";
import UsersPage from "./pages/users";
import MyFeedback from "./pages/my-feedback";
import FeedbackLog from "./pages/feedback-log";
import { Layout } from "./components/layout";
import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";

const queryClient = new QueryClient();

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// The Clerk proxy is a production-only path. A proxy URL can still be present
// in the shared environment while preview is running, but the dev API server
// intentionally does not mount the production proxy.
const clerkProxyUrl = import.meta.env.PROD
  ? import.meta.env.VITE_CLERK_PROXY_URL
  : undefined;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.png`,
  },
  variables: {
    colorPrimary: "hsl(220 90% 40%)",
    colorForeground: "hsl(222 47% 11%)",
    colorMutedForeground: "hsl(215 16% 47%)",
    colorDanger: "hsl(0 84% 60%)",
    colorBackground: "hsl(0 0% 100%)",
    colorInput: "hsl(0 0% 100%)",
    colorInputForeground: "hsl(222 47% 11%)",
    colorNeutral: "hsl(214 32% 91%)",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden border border-gray-200 shadow-sm",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-2xl font-bold text-gray-900 tracking-tight",
    headerSubtitle: "text-sm text-gray-500",
    socialButtonsBlockButtonText: "text-sm font-medium text-gray-700",
    formFieldLabel: "text-sm font-medium text-gray-900",
    footerActionLink: "text-sm font-medium text-blue-600 hover:text-blue-700",
    footerActionText: "text-sm text-gray-500",
    dividerText: "text-sm text-gray-400",
    identityPreviewEditButton: "text-sm font-medium text-blue-600 hover:text-blue-700",
    formFieldSuccessText: "text-sm text-green-600",
    alertText: "text-sm font-medium",
    logoBox: "flex justify-center mb-6",
    logoImage: "h-12 w-auto",
    socialButtonsBlockButton: "border border-gray-200 hover:bg-gray-50 rounded-lg",
    formButtonPrimary: "bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 rounded-lg",
    formFieldInput: "border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
    footerAction: "flex justify-center mt-6",
    dividerLine: "bg-gray-200",
    alert: "rounded-lg p-4",
    otpCodeFieldInput: "border border-gray-300 rounded-lg text-lg text-center",
    formFieldRow: "mb-4",
    main: "w-full",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  // Track the last *signed-in* user. Clerk's dev session can flicker to null
  // for a moment during token refresh; clearing the cache on that transient
  // null aborted in-flight queries and remounted pages mid-use (losing open
  // dialogs and typed form values). Only clear when a genuinely different
  // user signs in.
  const lastUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (userId === null) return; // transient sign-out flicker or real sign-out
      if (lastUserIdRef.current !== null && lastUserIdRef.current !== userId) {
        queryClient.clear();
      }
      lastUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

/**
 * Auth state with a grace period: a momentary signed-out flip (Clerk dev
 * token refresh) must not unmount the current page — that closes open
 * dialogs and wipes any half-typed form (e.g. a New Time Card Run).
 * Only report "out" when the signed-out state persists.
 */
function useStableAuthState(): "loading" | "in" | "out" {
  const { isLoaded, isSignedIn } = useUser();
  const [state, setState] = useState<"loading" | "in" | "out">("loading");

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      setState("in");
      return;
    }
    if (state !== "in") {
      setState("out");
      return;
    }
    // Was signed in and now appears signed out: wait before treating it as
    // a real sign-out so transient refresh flickers don't lose work.
    const timer = setTimeout(() => setState("out"), 5000);
    return () => clearTimeout(timer);
  }, [isLoaded, isSignedIn, state]);

  return state;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

function ProtectedRoute({ component: Component }: { component: any }) {
  const auth = useStableAuthState();
  if (auth === "loading") return null;
  if (auth === "out") return <Redirect to="/" />;
  return (
    <Layout>
      <Component />
    </Layout>
  );
}

function OwnerRoute({ component: Component }: { component: any }) {
  const auth = useStableAuthState();
  const { data: me, isLoading } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey(), enabled: auth === "in" },
  });
  if (auth === "loading") return null;
  if (auth === "out") return <Redirect to="/" />;
  if (isLoading) {
    return (
      <Layout>
        <div className="p-8 text-slate-500">Loading...</div>
      </Layout>
    );
  }
  if (me?.role !== "owner") return <Redirect to="/dashboard" />;
  return (
    <Layout>
      <Component />
    </Layout>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to access your account",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Get started today",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/dashboard"><ProtectedRoute component={Dashboard} /></Route>
          <Route path="/jobs"><ProtectedRoute component={Jobs} /></Route>
          <Route path="/jobs/:id"><ProtectedRoute component={JobDetail} /></Route>
          <Route path="/transactions"><ProtectedRoute component={Transactions} /></Route>
          <Route path="/checks-to-print"><ProtectedRoute component={ChecksToPrint} /></Route>
          <Route path="/invoices"><ProtectedRoute component={Invoices} /></Route>
          <Route path="/invoices/:id"><ProtectedRoute component={InvoiceDetail} /></Route>
          <Route path="/bills"><ProtectedRoute component={Bills} /></Route>
          <Route path="/bills/:id"><ProtectedRoute component={BillDetail} /></Route>
          <Route path="/accounts"><ProtectedRoute component={Accounts} /></Route>
          <Route path="/accounts/:id/register"><ProtectedRoute component={AccountRegister} /></Route>
          <Route path="/accounts/:id/reconcile/:periodId"><ProtectedRoute component={AccountReconcile} /></Route>
          <Route path="/accounts/:id/reconcile"><ProtectedRoute component={AccountReconcileList} /></Route>
          <Route path="/customers"><ProtectedRoute component={Customers} /></Route>
          <Route path="/customers/:id"><ProtectedRoute component={CustomerDetail} /></Route>
          <Route path="/vendors"><ProtectedRoute component={Vendors} /></Route>
          <Route path="/vendors/:id"><ProtectedRoute component={VendorDetail} /></Route>
          <Route path="/employees"><ProtectedRoute component={Employees} /></Route>
          <Route path="/employees/:id"><ProtectedRoute component={EmployeeDetail} /></Route>
          <Route path="/payroll"><ProtectedRoute component={Payroll} /></Route>
          <Route path="/payroll/:id"><ProtectedRoute component={PayrollDetail} /></Route>
          <Route path="/inbox"><ProtectedRoute component={InboxPage} /></Route>
          <Route path="/reports"><ProtectedRoute component={Reports} /></Route>
          <Route path="/reports/pnl"><ProtectedRoute component={ReportPnl} /></Route>
          <Route path="/reports/balance-sheet"><ProtectedRoute component={ReportBalanceSheet} /></Route>
          <Route path="/reports/costs"><ProtectedRoute component={ReportCosts} /></Route>
          <Route path="/reports/ar-aging"><ProtectedRoute component={ReportArAging} /></Route>
          <Route path="/reports/ap-aging"><ProtectedRoute component={ReportApAging} /></Route>
          <Route path="/my-feedback"><ProtectedRoute component={MyFeedback} /></Route>
          <Route path="/feedback-log"><OwnerRoute component={FeedbackLog} /></Route>
          <Route path="/users"><OwnerRoute component={UsersPage} /></Route>
          <Route component={NotFound} />
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
