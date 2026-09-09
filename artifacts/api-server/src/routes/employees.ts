import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
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
  GetEmployeeQueryParams,
  GetEmployeeResponse,
  UpdateEmployeeParams,
  UpdateEmployeeBody,
  DeleteEmployeeParams,
  ListEmployeeTimecardsParams,
  ListEmployeeTimecardsQueryParams,
  ListEmployeeTimecardsResponse,
  ExtractEmployeesBody,
  ExtractEmployeesResponse,
  MAX_EXTRACT_TEXT_LENGTH,
  extractTextTooLargeMessage,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/employees", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(employeesTable)
    .orderBy(employeesTable.name);
  res.json(
    ListEmployeesResponse.parse(
      rows.map((row) => ({
        ...row,
        // Raw SSNs never travel to list views; a masked form shows one is
        // on file.
        ssnMasked: row.ssn ? maskSsn(row.ssn) : null,
      })),
    ),
  );
});

router.post("/employees", async (req, res): Promise<void> => {
  const parsed = CreateEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // A masked SSN (•••-••-1234) echoed back from a form is not a real value;
  // never store the dots.
  if (parsed.data.ssn && parsed.data.ssn.includes("•")) {
    delete parsed.data.ssn;
  }
  // Creating an employee as inactive is admin-only (P7-GLB-05).
  if (parsed.data.active === false && req.currentUser?.role !== "owner") {
    res.status(403).json({
      error: "Only the owner can change an employee's active status",
    });
    return;
  }
  const [row] = await db.insert(employeesTable).values(parsed.data).returning();
  res
    .status(201)
    .json(
      GetEmployeeResponse.parse(
        row.ssn ? { ...row, ssn: maskSsn(row.ssn) } : row,
      ),
    );
});

const EXTRACT_EMPLOYEES_SYSTEM_PROMPT = `You extract employee payroll master records from documents: free-form text (emails, notes, rate sheets, CSV) or images/PDFs of employee lists. Formats vary widely.

Return ONLY a JSON object of this exact shape:
{"rows": [{"name": string, "regularRate": number|null, "overtimeRate": number|null, "taxExempt": boolean|null, "active": boolean|null, "notes": string|null}]}

Rules:
- One row per distinct employee.
- name: the person's name exactly as written (keep normal capitalization).
- regularRate: regular / straight-time hourly rate in DOLLARS (e.g. 30 for $30/hr). null when not stated. Convert salary-only info to null and mention it in notes.
- overtimeRate: overtime hourly rate in dollars. If only a multiplier is given (e.g. "1.5x OT"), compute it from the regular rate (30 * 1.5 = 45). null when neither is stated.
- taxExempt: true ONLY when the source explicitly says tax exempt / 1099 / contractor / no payroll taxes. false when it explicitly says W-2 / taxed normally. null otherwise.
- active: false ONLY when the source explicitly says inactive, terminated, or former employee. true when explicitly stated active. null otherwise.
- notes: short summary of other useful payroll details (deductions, tax filing status, title, start date). null when there is nothing extra.
- Numbers only for rates (no units, no "$"). Convert "$30.00/hr" to 30.
- Ignore anything that is not employee master data (hours worked, greetings, signatures, invoice amounts).
- If no employees are present, return {"rows": []}.`;

const MAX_EXTRACT_FILE_BYTES = 10 * 1024 * 1024;

function normalizeRate(value: unknown): number | null {
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

router.post("/employees/extract", async (req, res): Promise<void> => {
  const rawText = (req.body as { text?: unknown })?.text;
  if (typeof rawText === "string" && rawText.length > MAX_EXTRACT_TEXT_LENGTH) {
    res.status(400).json({ error: extractTextTooLargeMessage(rawText.length) });
    return;
  }

  const parsed = ExtractEmployeesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const text = (parsed.data.text ?? "").trim();
  const fileData = (parsed.data.fileData ?? "").trim();
  const fileName = (parsed.data.fileName ?? "").trim();
  if (!text && !fileData) {
    res.status(400).json({
      error: "Provide some text or attach an image/PDF to extract employees from",
    });
    return;
  }

  let filePart:
    | { type: "image_url"; image_url: { url: string } }
    | { type: "file"; file: { filename: string; file_data: string } }
    | null = null;
  if (fileData) {
    const match = /^data:([a-zA-Z0-9.+/-]+);base64,/.exec(fileData);
    if (!match) {
      res.status(400).json({ error: "The uploaded file must be a base64 data URL" });
      return;
    }
    const mime = match[1].toLowerCase();
    const base64Body = fileData.slice(match[0].length);
    const approxBytes = Math.floor((base64Body.length * 3) / 4);
    if (approxBytes > MAX_EXTRACT_FILE_BYTES) {
      res.status(400).json({
        error: "The uploaded file is too large. Keep it under 10 MB.",
      });
      return;
    }
    if (mime === "application/pdf") {
      filePart = {
        type: "file",
        file: { filename: fileName || "employees.pdf", file_data: fileData },
      };
    } else if (
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)
    ) {
      filePart = { type: "image_url", image_url: { url: fileData } };
    } else {
      res.status(400).json({
        error:
          "Unsupported file type. Upload a PNG, JPEG, WebP, or GIF image, or a PDF.",
      });
      return;
    }
  }

  let openai;
  try {
    ({ openai } = await import("@workspace/integrations-openai-ai-server"));
  } catch (err) {
    req.log?.error({ err }, "openai integration unavailable");
    res.status(503).json({
      error:
        "The employee reader is not configured. Please try again later.",
    });
    return;
  }

  const userParts: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
    | { type: "file"; file: { filename: string; file_data: string } }
  > = [];
  if (text) userParts.push({ type: "text", text });
  if (filePart) {
    if (!text) {
      userParts.push({
        type: "text",
        text: "Extract the employee records from this document.",
      });
    }
    userParts.push(filePart);
  }

  let content: string;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 8192,
      // Reading a form is extraction, not reasoning: low effort cuts the
      // wait from tens of seconds to a few without changing what is read.
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_EMPLOYEES_SYSTEM_PROMPT },
        // Cast: the OpenAI SDK's union type for content parts lags behind the
        // API, which accepts file parts on chat completions.
        { role: "user", content: userParts as never },
      ],
    });
    content = completion.choices[0]?.message?.content ?? "";
  } catch (err) {
    req.log?.error({ err }, "employee extraction failed");
    res.status(502).json({
      error: "The employee reader is unavailable. Please try again.",
    });
    return;
  }

  let rawRows: unknown;
  try {
    const obj = JSON.parse(content) as { rows?: unknown };
    rawRows = obj?.rows;
  } catch {
    res.status(502).json({
      error: "Could not read the employees from that upload. Please try again.",
    });
    return;
  }

  const rows = Array.isArray(rawRows)
    ? rawRows
        .map((r) => {
          const row = (r ?? {}) as Record<string, unknown>;
          const name = typeof row.name === "string" ? row.name.trim() : "";
          return {
            name,
            regularRate: normalizeRate(row.regularRate),
            overtimeRate: normalizeRate(row.overtimeRate),
            taxExempt: typeof row.taxExempt === "boolean" ? row.taxExempt : null,
            active: typeof row.active === "boolean" ? row.active : null,
            notes:
              typeof row.notes === "string" && row.notes.trim()
                ? row.notes.trim()
                : null,
          };
        })
        .filter((r) => r.name.length > 0)
    : [];

  if (rows.length === 0) {
    res.status(400).json({
      error: "No employee records were found. Check the format and try again.",
    });
    return;
  }

  res.json(ExtractEmployeesResponse.parse({ rows }));
});

/**
 * Masks an SSN down to its last four digits (•••-••-1234) so the raw value
 * never travels to the browser during normal profile browsing. Values with
 * fewer than four digits are fully masked rather than leaked as-is.
 */
export function maskSsn(ssn: string): string {
  const digits = ssn.replace(/\D/g, "");
  if (digits.length < 4) return "•••-••-••••";
  return `•••-••-${digits.slice(-4)}`;
}

router.get("/employees/:id", async (req, res): Promise<void> => {
  const params = GetEmployeeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const query = GetEmployeeQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
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
  // zod's boolean coercion turns any non-empty string (including "false")
  // into true, so require the literal string "true" to reveal.
  const reveal =
    query.data.reveal === true && String(req.query.reveal) === "true";
  const payload =
    !reveal && row.ssn ? { ...row, ssn: maskSsn(row.ssn) } : row;
  res.json(GetEmployeeResponse.parse(payload));
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
    .select({ id: employeesTable.id, name: employeesTable.name })
    .from(employeesTable)
    .where(eq(employeesTable.id, params.data.id));
  if (!employee) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  const sameNameRows = await db
    .select({ id: employeesTable.id })
    .from(employeesTable)
    .where(
      sql`lower(trim(${employeesTable.name})) = lower(trim(${employee.name}))`,
    );
  const legacyNameMatch =
    sameNameRows.length === 1
      ? and(
          isNull(payrollLinesTable.employeeId),
          sql`lower(trim(${payrollLinesTable.workerName})) = lower(trim(${employee.name}))`,
        )
      : undefined;
  // Old time cards were saved before employeeId was captured. Include a
  // name-only row only when this employee name is unique, so historical
  // numbers remain visible without ever assigning an ambiguous row to two
  // people.
  const conds = [
    legacyNameMatch
      ? or(eq(payrollLinesTable.employeeId, params.data.id), legacyNameMatch)
      : eq(payrollLinesTable.employeeId, params.data.id),
  ];
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
  // Flipping an employee between active and inactive is admin-only
  // (P7-GLB-05), matching the same rule on jobs. Other edits stay open.
  // Non-owners never write `active` at all (so no read-then-write race can
  // flip it); they only get a 403 when they explicitly asked to change it.
  const updateData = { ...parsed.data };
  // A masked SSN (•••-••-1234) echoed back from an edit form means
  // "unchanged" — keep the stored value, never store the dots.
  if (updateData.ssn && updateData.ssn.includes("•")) {
    delete updateData.ssn;
  }
  if (req.currentUser?.role !== "owner" && updateData.active != null) {
    const [existing] = await db
      .select({ active: employeesTable.active })
      .from(employeesTable)
      .where(eq(employeesTable.id, params.data.id));
    if (existing && updateData.active !== existing.active) {
      res.status(403).json({
        error: "Only the owner can change an employee's active status",
      });
      return;
    }
    delete updateData.active;
  }
  if (Object.keys(updateData).length === 0) {
    // Nothing left to write (e.g. a non-owner echoing the stored active
    // flag); return the current row instead of issuing an empty UPDATE.
    const [row] = await db
      .select()
      .from(employeesTable)
      .where(eq(employeesTable.id, params.data.id));
    if (!row) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }
    res.json(
      GetEmployeeResponse.parse(
        row.ssn ? { ...row, ssn: maskSsn(row.ssn) } : row,
      ),
    );
    return;
  }
  const [row] = await db
    .update(employeesTable)
    .set(updateData)
    .where(eq(employeesTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  res.json(
    GetEmployeeResponse.parse(
      row.ssn ? { ...row, ssn: maskSsn(row.ssn) } : row,
    ),
  );
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
