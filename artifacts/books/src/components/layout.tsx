import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  useCountIncompleteFeedback,
  getCountIncompleteFeedbackQueryKey,
  useCountMyFeedbackUpdates,
  getCountMyFeedbackUpdatesQueryKey,
} from "@workspace/api-client-react";
import {
  LayoutDashboard,
  Briefcase,
  ReceiptText,
  Building2,
  Users,
  HardHat,
  FileBarChart,
  LogOut,
  Wallet,
  ShieldCheck,
  FileText,
  FileInput,
  CircleDollarSign,
  MessageSquare,
  MessagesSquare,
} from "lucide-react";
import { FeedbackButton } from "./feedback-button";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { data: me } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });
  const isOwner = me?.role === "owner";
  // Surfaces new reports without opening the log; polls so the badge stays
  // fresh while the owner works elsewhere in the app.
  const { data: feedbackCount } = useCountIncompleteFeedback({
    query: {
      queryKey: getCountIncompleteFeedbackQueryKey(),
      enabled: isOwner,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });
  const incompleteCount = isOwner ? (feedbackCount?.count ?? 0) : 0;
  // Tells submitters their own feedback moved (in review / complete) since
  // they last opened My Feedback; polls so the badge appears while they work.
  const { data: myUpdates } = useCountMyFeedbackUpdates({
    query: {
      queryKey: getCountMyFeedbackUpdatesQueryKey(),
      enabled: me != null,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });
  const myUpdatesCount = myUpdates?.count ?? 0;

  const navItems = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/customers", label: "Customers", icon: Building2 },
    { href: "/jobs", label: "Jobs", icon: Briefcase },
    { href: "/invoices", label: "Invoices", icon: FileText },
    { href: "/bills", label: "Bills", icon: FileInput },
    { href: "/transactions", label: "Transactions", icon: ReceiptText },
    { href: "/accounts", label: "Chart of Accounts", icon: Wallet },
    { href: "/vendors", label: "Vendors", icon: HardHat },
    { href: "/employees", label: "Employees", icon: Users },
    { href: "/payroll", label: "Time Cards", icon: CircleDollarSign },
    { href: "/reports", label: "Reports", icon: FileBarChart },
    { href: "/my-feedback", label: "My Feedback", icon: MessageSquare },
    ...(isOwner
      ? [
          { href: "/feedback-log", label: "Feedback Log", icon: MessagesSquare },
          { href: "/users", label: "Users", icon: ShieldCheck },
        ]
      : []),
  ];

  // Human-readable trail for the global Feedback button, e.g. "Reports".
  const currentNav = navItems.find((i) => location.startsWith(i.href));

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <div className="w-64 bg-slate-900 text-slate-300 flex flex-col fixed inset-y-0 z-10 border-r border-slate-800 shadow-xl">
        <div className="h-16 flex items-center px-6 border-b border-slate-800 bg-slate-950">
          <img src={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/logo.png`} alt="Logo" className="h-8 w-8 mr-3 brightness-0 invert" />
          <span className="font-bold text-white tracking-tight">Allied Power</span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = location.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                  active
                    ? "bg-slate-800 text-white shadow-sm ring-1 ring-slate-700/50"
                    : "hover:bg-slate-800/50 hover:text-white"
                }`}
              >
                <Icon className={`mr-3 h-5 w-5 flex-shrink-0 ${active ? "text-blue-400" : "text-slate-400"}`} />
                <span className="flex-1">{item.label}</span>
                {item.href === "/my-feedback" && myUpdatesCount > 0 && (
                  <span
                    className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-blue-500 px-1.5 py-0.5 text-xs font-semibold leading-none text-white"
                    data-testid="badge-my-feedback-updates"
                  >
                    {myUpdatesCount > 99 ? "99+" : myUpdatesCount}
                  </span>
                )}
                {item.href === "/feedback-log" && incompleteCount > 0 && (
                  <span
                    className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-blue-500 px-1.5 py-0.5 text-xs font-semibold leading-none text-white"
                    data-testid="badge-feedback-count"
                  >
                    {incompleteCount > 99 ? "99+" : incompleteCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 bg-slate-950">
          <div className="flex items-center mb-4">
            <div className="h-8 w-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-medium text-white">
              {user?.firstName?.[0] || user?.emailAddresses[0]?.emailAddress[0]?.toUpperCase() || "?"}
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-white truncate w-40">{user?.fullName || "User"}</p>
              <p className="text-xs text-slate-400 truncate w-40">{user?.emailAddresses[0]?.emailAddress}</p>
            </div>
          </div>
          <button
            onClick={() => signOut({ redirectUrl: import.meta.env.BASE_URL })}
            className="w-full flex items-center px-3 py-2 text-sm font-medium rounded-md text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
          >
            <LogOut className="mr-3 h-5 w-5 text-slate-500" />
            Sign Out
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="pl-64 flex-1 flex flex-col">
        <main className="flex-1 p-8">
          <div className="mx-auto max-w-6xl">
            {children}
          </div>
        </main>
        {/* z-[60] sits above dialog/sheet overlays (z-50) so the button stays
            visible while any pop-up is open. text-slate-700 overrides the
            secondary variant's white foreground (invisible against bg-white). */}
        <div className="fixed bottom-6 right-6 z-[60]">
          <FeedbackButton
            targetType="page"
            targetId={location}
            location={currentNav?.label}
            variant="secondary"
            className="shadow-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
          />
        </div>
      </div>
    </div>
  );
}
