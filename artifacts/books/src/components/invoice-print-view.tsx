import {
  COMPANY,
  CATEGORY_LABEL,
  formatPrintDate,
  termsLabel,
  printTotals,
  type InvoicePrintData,
} from "@/lib/invoice-print";
import { formatCents } from "@/lib/format";

/**
 * On-screen preview that renders the invoice exactly as the customer will
 * see it (mirrors the PDF export layout, which mirrors Mike's QuickBooks
 * invoice format).
 */
export function InvoicePrintView({ data }: { data: InvoicePrintData }) {
  const { subtotalCents, totalCents, balanceCents } = printTotals(data);
  const money = (c: number) => formatCents(c).replace("$", "");

  return (
    <div className="bg-white text-slate-900 p-8 text-sm" data-testid="invoice-preview">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-lg font-bold">{COMPANY.name}</p>
          {COMPANY.addressLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          <p>{COMPANY.email}</p>
        </div>
        <p className="text-2xl font-semibold tracking-wide text-slate-700">INVOICE</p>
      </div>

      <div className="mt-6 flex justify-between gap-8">
        <div className="flex gap-12">
          <div>
            <p className="text-xs font-semibold text-slate-500">BILL TO</p>
            <p className="font-medium">{data.customerName ?? ""}</p>
            {(data.customerAddress ?? "").split("\n").filter(Boolean).map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500">SHIP TO</p>
            <p className="font-medium">{data.customerName ?? ""}</p>
            {(data.customerAddress ?? "").split("\n").filter(Boolean).map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
        </div>
        <table className="text-right">
          <tbody>
            <tr>
              <td className="pr-4 text-xs font-semibold text-slate-500">INVOICE #</td>
              <td>{data.invoiceNumber}</td>
            </tr>
            <tr>
              <td className="pr-4 text-xs font-semibold text-slate-500">DATE</td>
              <td>{formatPrintDate(data.date)}</td>
            </tr>
            {data.dueDate ? (
              <tr>
                <td className="pr-4 text-xs font-semibold text-slate-500">DUE DATE</td>
                <td>{formatPrintDate(data.dueDate)}</td>
              </tr>
            ) : null}
            <tr>
              <td className="pr-4 text-xs font-semibold text-slate-500">TERMS</td>
              <td>{termsLabel(data.date, data.dueDate)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {data.poNumber ? (
        <div className="mt-6">
          <p className="text-xs font-semibold text-slate-500">P.O. NUMBER</p>
          <p>{data.poNumber}</p>
        </div>
      ) : null}

      <table className="mt-6 w-full">
        <thead>
          <tr className="border-b border-slate-300 text-xs font-semibold text-slate-500">
            <th className="py-1 text-left">SERVICE</th>
            <th className="py-1 text-left">DESCRIPTION</th>
            <th className="py-1 text-right">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-100 align-top">
              <td className="py-2 pr-4 whitespace-nowrap">
                {l.category ? CATEGORY_LABEL[l.category] : ""}
              </td>
              <td className="py-2 pr-4 whitespace-pre-wrap">{l.description ?? ""}</td>
              <td className="py-2 text-right">{money(l.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.memo ? <p className="mt-4 whitespace-pre-wrap">{data.memo}</p> : null}

      <div className="mt-6 flex justify-between items-end">
        <p className="text-slate-600">Thank you for your business.</p>
        <table className="text-right">
          <tbody>
            <tr>
              <td className="pr-6 text-xs font-semibold text-slate-500">SUBTOTAL</td>
              <td>{money(subtotalCents)}</td>
            </tr>
            <tr>
              <td className="pr-6 text-xs font-semibold text-slate-500">TOTAL</td>
              <td>{money(totalCents)}</td>
            </tr>
            <tr>
              <td className="pr-6 text-xs font-semibold text-slate-500">BALANCE DUE</td>
              <td className="text-lg font-bold">{formatCents(balanceCents)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
