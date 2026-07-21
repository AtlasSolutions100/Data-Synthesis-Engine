import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import {
  db,
  employeesTable,
  payrollLinesTable,
  payrollRunsTable,
} from "@workspace/db";
import {
  ListEmployeesResponse,
  CreateEmployeeBody,
  GetEmployeeParams,
  GetEmployeeResponse,
  UpdateEmployeeParams,
  UpdateEmployeeBody,
  DeleteEmployeeParams,
  ListEmployeeTimecardsParams,
  ListEmployeeTimecardsQueryParams,
  ListEmployeeTimecardsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/employees", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(employeesTable)
    .orderBy(employeesTable.name);
  res.json(ListEmployeesResponse.parse(rows));
});

router.post("/employees", async (req, res): Promise<void> => {
  const parsed = CreateEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(employeesTable).values(parsed.data).returning();
  res.status(201).json(GetEmployeeResponse.parse(row));
});

router.get("/employees/:id", async (req, res): Promise<void> => {
  const params = GetEmployeeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  res.json(GetEmployeeResponse.parse(row));
});

router.get("/employees/:id/timecards", async (req, res): Promise<void> => {
  const params = ListEmployeeTimecardsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const query = ListEmployeeTimecardsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const [employee] = await db
    .select({ id: employeesTable.id })
    .from(employeesTable)
    .where(eq(employeesTable.id, params.data.id));
  if (!employee) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  const conds = [eq(payrollLinesTable.employeeId, params.data.id)];
  if (query.data.year != null) {
    conds.push(
      gte(payrollRunsTable.payPeriodStart, `${query.data.year}-01-01`),
      lte(payrollRunsTable.payPeriodStart, `${query.data.year}-12-31`),
    );
  }

  const rows = await db
    .select({
      line: payrollLinesTable,
      run: payrollRunsTable,
    })
    .from(payrollLinesTable)
    .innerJoin(
      payrollRunsTable,
      eq(payrollRunsTable.id, payrollLinesTable.runId),
    )
    .where(and(...conds))
    .orderBy(desc(payrollRunsTable.payPeriodStart), desc(payrollLinesTable.id));

  const items = rows.map((r) => ({
    runId: r.run.id,
    payPeriodStart: r.run.payPeriodStart,
    payPeriodEnd: r.run.payPeriodEnd,
    payDate: r.run.payDate,
    posted: r.run.posted,
    regularHours: Number(r.line.regularHours),
    overtimeHours: Number(r.line.overtimeHours),
    holidayHours: Number(r.line.holidayHours),
    grossWagesCents: Number(r.line.grossWagesCents),
    totalCostCents: Number(r.line.totalCostCents),
  }));
  res.json(ListEmployeeTimecardsResponse.parse(items));
});

router.patch("/employees/:id", async (req, res): Promise<void> => {
  const params = UpdateEmployeeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(employeesTable)
    .set(parsed.data)
    .where(eq(employeesTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  res.json(GetEmployeeResponse.parse(row));
});

router.delete("/employees/:id", async (req, res): Promise<void> => {
  const params = DeleteEmployeeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(employeesTable)
    .where(eq(employeesTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
