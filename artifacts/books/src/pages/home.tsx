import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { HardHat, Activity, FileSpreadsheet, Zap } from "lucide-react";

export default function Home() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Navigation */}
      <nav className="border-b border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center">
              <Zap className="h-8 w-8 text-blue-600 mr-2" />
              <span className="text-xl font-bold text-slate-900 tracking-tight">Allied Power</span>
            </div>
            <div className="flex items-center space-x-4">
              <Link href={`${basePath}/sign-in`}>
                <Button variant="ghost" className="text-slate-600 hover:text-slate-900">Sign In</Button>
              </Link>
              <Link href={`${basePath}/sign-up`}>
                <Button className="bg-blue-600 hover:bg-blue-700 text-white">Sign Up</Button>
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <main>
        <div className="relative pt-16 pb-32 flex content-center items-center justify-center min-h-[75vh]">
          <div className="absolute top-0 w-full h-full bg-slate-900 bg-[url('https://images.unsplash.com/photo-1541888086925-92051dbdd9f7?q=80&w=2000&auto=format&fit=crop')] bg-cover bg-center">
            <span id="blackOverlay" className="w-full h-full absolute opacity-75 bg-slate-900"></span>
          </div>
          <div className="container relative mx-auto">
            <div className="items-center flex flex-wrap">
              <div className="w-full lg:w-6/12 px-4 ml-auto mr-auto text-center">
                <div className="pr-12">
                  <h1 className="text-white font-bold text-5xl tracking-tight leading-tight">
                    Construction Accounting, <br/> Built for the Trades.
                  </h1>
                  <p className="mt-4 text-lg text-slate-300">
                    Replace generic accounting software with a tool designed specifically for job-costing. 
                    Track income, costs, and profits per job in real-time. Precision matters.
                  </p>
                  <div className="mt-8 flex justify-center gap-4">
                    <Link href={`${basePath}/sign-up`}>
                      <Button size="lg" className="bg-blue-600 hover:bg-blue-700 text-white px-8 text-lg h-14 rounded-xl">
                        Start Building
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Features Section */}
        <section className="pb-20 bg-slate-50 -mt-24">
          <div className="container mx-auto px-4">
            <div className="flex flex-wrap">
              <div className="lg:pt-12 pt-6 w-full md:w-4/12 px-4 text-center">
                <div className="relative flex flex-col min-w-0 break-words bg-white w-full mb-8 shadow-lg rounded-2xl p-8 border border-slate-100">
                  <div className="mx-auto w-16 h-16 mb-6 shadow-md rounded-full bg-blue-100 flex items-center justify-center text-blue-600">
                    <HardHat size={32} />
                  </div>
                  <h6 className="text-xl font-semibold text-slate-900">Job Costing First</h6>
                  <p className="mt-2 mb-4 text-slate-500">
                    Every transaction is tied to a job. Know exactly where you stand on every project with real-time profit tracking.
                  </p>
                </div>
              </div>

              <div className="w-full md:w-4/12 px-4 text-center">
                <div className="relative flex flex-col min-w-0 break-words bg-white w-full mb-8 shadow-lg rounded-2xl p-8 border border-slate-100">
                  <div className="mx-auto w-16 h-16 mb-6 shadow-md rounded-full bg-orange-100 flex items-center justify-center text-orange-600">
                    <Activity size={32} />
                  </div>
                  <h6 className="text-xl font-semibold text-slate-900">Real-time Dashboard</h6>
                  <p className="mt-2 mb-4 text-slate-500">
                    See your total income, COGS, expenses, and net profit at a glance. No more waiting for end-of-month reports.
                  </p>
                </div>
              </div>

              <div className="pt-6 w-full md:w-4/12 px-4 text-center">
                <div className="relative flex flex-col min-w-0 break-words bg-white w-full mb-8 shadow-lg rounded-2xl p-8 border border-slate-100">
                  <div className="mx-auto w-16 h-16 mb-6 shadow-md rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600">
                    <FileSpreadsheet size={32} />
                  </div>
                  <h6 className="text-xl font-semibold text-slate-900">Account Level Detail</h6>
                  <p className="mt-2 mb-4 text-slate-500">
                    Drill down into costs by account. Track labor, materials, and overhead precisely to improve future bidding.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
