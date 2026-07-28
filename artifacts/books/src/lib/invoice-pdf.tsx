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
 * Generates and downloads the invoice PDF (same layout as InvoicePrintView).
 * @react-pdf/renderer is heavy, so it is imported lazily on first export.
 */
export async function downloadInvoicePdf(data: InvoicePrintData): Promise<void> {
  const { Document, Page, Text, View, StyleSheet, pdf } = await import(
    "@react-pdf/renderer"
  );

  const s = StyleSheet.create({
    page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#111827" },
    row: { flexDirection: "row", justifyContent: "space-between" },
    bold: { fontFamily: "Helvetica-Bold" },
    label: { fontSize: 8, color: "#64748b", fontFamily: "Helvetica-Bold" },
    title: { fontSize: 18, color: "#334155", fontFamily: "Helvetica-Bold" },
    tableHead: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: "#cbd5e1",
      paddingBottom: 3,
      marginTop: 18,
    },
    line: {
      flexDirection: "row",
      borderBottomWidth: 0.5,
      borderBottomColor: "#e2e8f0",
      paddingVertical: 5,
    },
    colService: { width: "16%" },
    colDesc: { width: "64%", paddingRight: 8 },
    colAmt: { width: "20%", textAlign: "right" },
  });

  const money = (c: number) => formatCents(c).replace("$", "");
  const { subtotalCents, totalCents, balanceCents } = printTotals(data);
  const addressLines = (data.customerAddress ?? "").split("\n").filter(Boolean);

  const doc = (
    <Document>
      <Page size="LETTER" style={s.page}>
        <View style={s.row}>
          <View>
            <Text style={[s.bold, { fontSize: 12 }]}>{COMPANY.name}</Text>
            {COMPANY.addressLines.map((l) => (
              <Text key={l}>{l}</Text>
            ))}
            <Text>{COMPANY.email}</Text>
          </View>
          <Text style={s.title}>INVOICE</Text>
        </View>

        <View style={[s.row, { marginTop: 24 }]}>
          <View style={{ flexDirection: "row" }}>
            <View style={{ marginRight: 40 }}>
              <Text style={s.label}>BILL TO</Text>
              <Text style={s.bold}>{data.customerName ?? ""}</Text>
              {addressLines.map((l, i) => (
                <Text key={i}>{l}</Text>
              ))}
            </View>
            <View>
              <Text style={s.label}>SHIP TO</Text>
              <Text style={s.bold}>{data.customerName ?? ""}</Text>
              {addressLines.map((l, i) => (
                <Text key={i}>{l}</Text>
              ))}
            </View>
          </View>
          <View>
            <Text>
              <Text style={s.label}>INVOICE #  </Text>
              {data.invoiceNumber}
            </Text>
            <Text>
              <Text style={s.label}>DATE  </Text>
              {formatPrintDate(data.date)}
            </Text>
            {data.dueDate ? (
              <Text>
                <Text style={s.label}>DUE DATE  </Text>
                {formatPrintDate(data.dueDate)}
              </Text>
            ) : null}
            <Text>
              <Text style={s.label}>TERMS  </Text>
              {termsLabel(data.date, data.dueDate)}
            </Text>
          </View>
        </View>

        {data.poNumber ? (
          <View style={{ marginTop: 18 }}>
            <Text style={s.label}>P.O. NUMBER</Text>
            <Text>{data.poNumber}</Text>
          </View>
        ) : null}

        <View style={s.tableHead}>
          <Text style={[s.label, s.colService]}>SERVICE</Text>
          <Text style={[s.label, s.colDesc]}>DESCRIPTION</Text>
          <Text style={[s.label, s.colAmt]}>AMOUNT</Text>
        </View>
        {data.lines.map((l, i) => (
          <View key={i} style={s.line}>
            <Text style={s.colService}>
              {l.category ? CATEGORY_LABEL[l.category] : ""}
            </Text>
            <Text style={s.colDesc}>{l.description ?? ""}</Text>
            <Text style={s.colAmt}>{money(l.amountCents)}</Text>
          </View>
        ))}

        {data.memo ? <Text style={{ marginTop: 12 }}>{data.memo}</Text> : null}

        <View style={[s.row, { marginTop: 24 }]}>
          <Text style={{ color: "#475569" }}>Thank you for your business.</Text>
          <View>
            <View style={s.row}>
              <Text style={[s.label, { marginRight: 24 }]}>SUBTOTAL</Text>
              <Text>{money(subtotalCents)}</Text>
            </View>
            <View style={s.row}>
              <Text style={[s.label, { marginRight: 24 }]}>TOTAL</Text>
              <Text>{money(totalCents)}</Text>
            </View>
            <View style={s.row}>
              <Text style={[s.label, { marginRight: 24 }]}>BALANCE DUE</Text>
              <Text style={[s.bold, { fontSize: 13 }]}>{formatCents(balanceCents)}</Text>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );

  const blob = await pdf(doc).toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Invoice_${data.invoiceNumber.replace(/[^\w-]+/g, "_")}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
