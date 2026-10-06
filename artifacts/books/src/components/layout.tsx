import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  useCountIncompleteFeedback,
  getCountIncompleteFeedbackQueryKey,
  useCountMyFeedbackUpdates,
  getCountMyFeedbackUpdatesQueryKey,
  useListInboundEmails,
  getListInboundEmailsQueryKey,
  useListChecksToPrint,
  getListChecksToPrintQueryKey,
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
  Inbox,
  Printer,
  FileUp,
  type LucideIcon,
} from "lucide-react";
import { FeedbackButton } from "./feedback-button";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = { label: string | null; items: NavItem[] };

/**
 * App shell. An ink-navy sidebar with one amber "live wire" accent (Allied
 * Power is an electrical contractor) frames the warm paper workspace where
 * the ledger lives. Navigation is grouped the way the bookkeeping actually
 * flows (money in, money out, the books, support) so the fifteen
 * destinations scan as four short lists instead of one long one.
 */
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
  // Forwarded mail waiting for review — the one count that should pull
  // attention, since it is work arriving from outside the app.
  const inboxParams = { status: "new" as const };
  const { data: inboxNew } = useListInboundEmails(inboxParams, {
    query: {
      queryKey: getListInboundEmailsQueryKey(inboxParams),
      enabled: me != null,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });
  const inboxCount = inboxNew?.length ?? 0;
  // Checks written but not numbered yet, so none gets forgotten (2026-09-25).
  const { data: toPrint } = useListChecksToPrint({
    query: {
      queryKey: getListChecksToPrintQueryKey(),
      enabled: me != null,
      refetchInterval: 120_000,
      refetchOnWindowFocus: true,
    },
  });
  const toPrintCount = toPrint?.length ?? 0;

  const groups: NavGroup[] = [
    {
      label: null,
      items: [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/inbox", label: "Inbox", icon: Inbox },
      ],
    },
    {
      label: "Money in",
      items: [
        { href: "/customers", label: "Customers", icon: Building2 },
        { href: "/jobs", label: "Jobs", icon: Briefcase },
        { href: "/invoices", label: "Invoices", icon: FileText },
      ],
    },
    {
      label: "Money out",
      items: [
        { href: "/vendors", label: "Vendors", icon: HardHat },
        { href: "/bills", label: "Bills", icon: FileInput },
        { href: "/employees", label: "Employees", icon: Users },
        { href: "/payroll", label: "Time Cards", icon: CircleDollarSign },
      ],
    },
    {
      label: "Books",
      items: [
        { href: "/accounts", label: "Chart of Accounts", icon: Wallet },
        { href: "/checks-to-print", label: "Checks to Print", icon: Printer },
        { href: "/statements/import", label: "Import Statement", icon: FileUp },
        { href: "/transactions", label: "Transactions", icon: ReceiptText },
        { href: "/reports", label: "Reports", icon: FileBarChart },
      ],
    },
    {
      label: "Support",
      items: [
        { href: "/my-feedback", label: "My Feedback", icon: MessageSquare },
        ...(isOwner
          ? [
              { href: "/feedback-log", label: "Feedback Log", icon: MessagesSquare },
              { href: "/users", label: "Users", icon: ShieldCheck },
            ]
          : []),
      ],
    },
  ];
  const navItems = groups.flatMap((g) => g.items);

  // Human-readable trail for the global Feedback button, e.g. "Reports".
  const currentNav = navItems.find((i) => location.startsWith(i.href));

  const badgeFor = (href: string): { count: number; testId: string } | null => {
    if (href === "/inbox" && inboxCount > 0) return { count: inboxCount, testId: "badge-inbox-count" };
    if (href === "/checks-to-print" && toPrintCount > 0) return { count: toPrintCount, testId: "badge-checks-to-print" };
    if (href === "/my-feedback" && myUpdatesCount > 0) return { count: myUpdatesCount, testId: "badge-my-feedback-updates" };
    if (href === "/feedback-log" && incompleteCount > 0) return { count: incompleteCount, testId: "badge-feedback-count" };
    return null;
  };

  const initial =
    user?.firstName?.[0] ||
    user?.emailAddresses[0]?.emailAddress[0]?.toUpperCase() ||
    "?";

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar */}
      <aside className="w-60 fixed inset-y-0 z-10 flex flex-col bg-sidebar text-sidebar-foreground">
        {/* Brand block: ink navy with a live-wire amber rule — the one place
            the brand colour is used decoratively. */}
        <div className="h-14 flex items-center gap-3 px-4 border-b border-sidebar-border">
          <div className="relative h-8 w-8 rounded-md bg-brand/15 flex items-center justify-center">
            <img
              src={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/logo.png`}
              alt=""
              className="h-5 w-5 brightness-0 invert opacity-90"
            />
            <span aria-hidden className="absolute -bottom-0.5 left-1.5 right-1.5 h-0.5 rounded-full bg-brand" />
          </div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-tight">Allied Power</div>
            <div className="text-[11px] text-sidebar-muted">Books</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Main">
          {groups.map((group, gi) => (
            <div key={group.label ?? "top"} className={gi === 0 ? "" : "mt-4"}>
              {group.label && (
                <div className="eyebrow px-3 pb-1.5 !text-sidebar-muted/80">{group.label}</div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = location.startsWith(item.href);
                  const badge = badgeFor(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`group relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
                        active
                          ? "bg-sidebar-active text-white font-medium"
                          : "text-sidebar-foreground/75 hover:bg-sidebar-active/60 hover:text-white"
                      }`}
                    >
                      {active && (
                        <span
                          aria-hidden
                          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-brand"
                        />
                      )}
                      <Icon
                        className={`h-4 w-4 flex-shrink-0 ${
                          active ? "text-brand" : "text-sidebar-muted group-hover:text-white"
                        }`}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1 truncate">{item.label}</span>
                      {badge && (
                        <span
                          className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none ${
                            item.href === "/inbox"
                              ? "bg-brand text-brand-foreground"
                              : "bg-sidebar-active text-sidebar-foreground ring-1 ring-sidebar-border"
                          }`}
                          data-testid={badge.testId}
                        >
                          {badge.count > 99 ? "99+" : badge.count}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2.5 px-1">
            <div className="h-8 w-8 rounded-full bg-brand text-brand-foreground flex items-center justify-center text-xs font-bold">
              {initial}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-[13px] font-medium truncate">{user?.fullName || "User"}</p>
              <p className="text-[11px] text-sidebar-muted truncate">
                {user?.emailAddresses[0]?.emailAddress}
              </p>
            </div>
            <button
              onClick={() => signOut({ redirectUrl: import.meta.env.BASE_URL })}
              title="Sign out"
              aria-label="Sign out"
              className="rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-active hover:text-white transition-colors"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="pl-60 flex-1 flex flex-col min-w-0">
        <main className="flex-1 px-8 py-7">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
        {/* z-[60] sits above dialog/sheet overlays (z-50) so the button stays
            visible while any pop-up is open. */}
        <div className="fixed bottom-6 right-6 z-[60]">
          <FeedbackButton
            targetType="page"
            targetId={location}
            location={currentNav?.label}
            variant="outline"
            className="bg-card text-foreground shadow-card"
          />
        </div>
      </div>
    </div>
  );
}
