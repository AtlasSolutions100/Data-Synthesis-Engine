import { useGetCostByAccount, getGetCostByAccountQueryKey } from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function Reports() {
  const { data: report, isLoading } = useGetCostByAccount({
    query: { queryKey: getGetCostByAccountQueryKey() }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Reports</h1>
          <p className="text-slate-500 mt-1">Cost by Account breakdown</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Costs Across All Jobs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-8 text-slate-500">Loading report...</TableCell>
                </TableRow>
              ) : !report || report.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-8 text-slate-500">No data available.</TableCell>
                </TableRow>
              ) : (
                report.map((row) => (
                  <TableRow key={row.accountId}>
                    <TableCell className="font-medium">{row.accountNumber} - {row.accountName}</TableCell>
                    <TableCell className="capitalize">{row.type.replace('_', ' ')}</TableCell>
                    <TableCell className="text-right">{formatCents(row.amountCents)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
