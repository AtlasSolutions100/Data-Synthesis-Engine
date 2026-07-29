import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { eq, like } from "drizzle-orm";
import { db, employeesTable } from "@workspace/db";

/**
 * P7-GLB-05 permissions: flipping an employee between active and inactive is
 * admin-only (owner role), matching the same rule on jobs. Other employee
 * edits remain open to bookkeepers.
 */

const TP = "TESTEMPPERM";

let app: Express;
let employeeId: number;
let currentRole: "owner" | "bookkeeper" = "owner";

beforeAll(async () => {
  await db.delete(employeesTable).where(like(employeesTable.name, `${TP}%`));
  const { default: employeesRouter } = await import("./employees");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = { role: currentRole } as never;
    next();
  });
  app.use("/api", employeesRouter);

  const [emp] = await db
    .insert(employeesTable)
    .values({ name: `${TP} Worker`, active: true })
    .returning();
  employeeId = emp.id;
});

afterAll(async () => {
  await db.delete(employeesTable).where(eq(employeesTable.id, employeeId));
});

describe("employee active/inactive permission", () => {
  it("blocks a bookkeeper from deactivating an employee", async () => {
    currentRole = "bookkeeper";
    const res = await request(app)
      .patch(`/api/employees/${employeeId}`)
      .send({ active: false });
    expect(res.status).toBe(403);
    const [row] = await db
      .select({ active: employeesTable.active })
      .from(employeesTable)
      .where(eq(employeesTable.id, employeeId));
    expect(row.active).toBe(true);
  });

  it("lets a bookkeeper edit other fields, sending the unchanged active flag", async () => {
    currentRole = "bookkeeper";
    const res = await request(app)
      .patch(`/api/employees/${employeeId}`)
      .send({ active: true, phone: "555-0100" });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe("555-0100");
  });

  it("blocks a bookkeeper from creating an employee already inactive", async () => {
    currentRole = "bookkeeper";
    const res = await request(app)
      .post("/api/employees")
      .send({ name: `${TP} Ghost`, active: false });
    expect(res.status).toBe(403);
  });

  it("lets the owner deactivate and reactivate", async () => {
    currentRole = "owner";
    const off = await request(app)
      .patch(`/api/employees/${employeeId}`)
      .send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    const on = await request(app)
      .patch(`/api/employees/${employeeId}`)
      .send({ active: true });
    expect(on.status).toBe(200);
    expect(on.body.active).toBe(true);
  });
});
