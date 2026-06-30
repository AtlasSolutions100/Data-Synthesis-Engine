import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
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
} from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { data: me } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  const navItems = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/jobs", label: "Jobs", icon: Briefcase },
    { href: "/invoices", label: "Invoices", icon: FileText },
    { href: "/bills", label: "Bills", icon: FileInput },
    { href: "/transactions", label: "Transactions", icon: ReceiptText },
    { href: "/accounts", label: "Accounts", icon: Wallet },
    { href: "/customers", label: "Customers", icon: Building2 },
    { href: "/vendors", label: "Vendors", icon: HardHat },
    { href: "/employees", label: "Employees", icon: Users },
    { href: "/payroll", label: "Payroll", icon: CircleDollarSign },
    { href: "/reports", label: "Reports", icon: FileBarChart },
    ...(me?.role === "owner"
      ? [{ href: "/users", label: "Users", icon: ShieldCheck }]
      : []),
  ];

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
                {item.label}
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
      </div>
    </div>
  );
}
