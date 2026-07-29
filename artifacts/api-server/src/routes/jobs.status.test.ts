import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { eq, like } from "drizzle-orm";
import { db, customersTable, jobsTable, employeesTable } from "@workspace/db";

/**
 * Phase 4a: job Active/Inactive status management (owner-only flip, note on
 * deactivation, default list hides inactive) and expanded employee profile
 * fields (address, email, phone, hire/termination dates, SSN).
 */

const TP = "TESTSTATUS";

let app: Express;
let customerId: number;
let jobId: number;
let currentRole: "owner" | "bookkeeper" = "owner";

async function cleanup(): Promise<void> {
  await db.delete(jobsTable).where(like(jobsTable.name, `${TP}%`));
  await db.delete(customersTable).where(eq(customersTable.name, `${TP} Cust`));
  await db.delete(employeesTable).where(like(employeesTable.name, `${TP}%`));
}

beforeAll(async () => {
  await cleanup();
  const { default: jobsRouter } = await import("./jobs");
  const { default: employeesRouter } = await import("./employees");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = { role: currentRole } as never;
    next();
  });
  app.use("/api", jobsRouter);
  app.use("/api", employeesRouter);

  const [cust] = await db
    .insert(customersTable)
    .values({ name: `${TP} Cust` })
    .returning();
  customerId = cust.id;
  const [job] = await db
    .insert(jobsTable)
    .values({ name: `${TP} Job A`, jobNumber: `${TP}-J1`, customerId })
    .returning();
  jobId = job.id;
});

afterAll(cleanup);

describe("job inactive status (P4-CUST-02/03/04)", () => {
  it("owner can mark a job inactive with a note; note is returned", async () => {
    currentRole = "owner";
    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .send({ status: "inactive", inactiveNote: "Customer paused the project" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("inactive");
    expect(res.body.inactiveNote).toBe("Customer paused the project");
  });

  it("default job list hides inactive jobs; includeInactive surfaces them", async () => {
    const def = await request(app).get("/api/jobs");
    expect(def.status).toBe(200);
    expect(def.body.some((j: { id: number }) => j.id === jobId)).toBe(false);

    const all = await request(app).get("/api/jobs?includeInactive=true");
    expect(all.status).toBe(200);
    const found = all.body.find((j: { id: number }) => j.id === jobId);
    expect(found).toBeTruthy();
    expect(found.status).toBe("inactive");
    expect(found.inactiveNote).toBe("Customer paused the project");
  });

  it("explicit includeInactive=false still hides inactive jobs", async () => {
    const res = await request(app).get("/api/jobs?includeInactive=false");
    expect(res.status).toBe(200);
    expect(res.body.some((j: { id: number }) => j.id === jobId)).toBe(false);
  });

  it("bookkeeper cannot reactivate an inactive job (403)", async () => {
    currentRole = "bookkeeper";
    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .send({ status: "active" });
    expect(res.status).toBe(403);
  });

  it("bookkeeper can still edit other fields without touching status", async () => {
    currentRole = "bookkeeper";
    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .send({ description: "updated by bookkeeper" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("inactive");
  });

  it("owner reactivates; note is kept for history", async () => {
    currentRole = "owner";
    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .send({ status: "active" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.inactiveNote).toBe("Customer paused the project");

    const def = await request(app).get("/api/jobs");
    expect(def.body.some((j: { id: number }) => j.id === jobId)).toBe(true);
  });

  it("bookkeeper cannot mark an active job inactive (403)", async () => {
    currentRole = "bookkeeper";
    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .send({ status: "inactive" });
    expect(res.status).toBe(403);
  });

  it("bookkeeper can flip between completed and on_hold (not owner-gated)", async () => {
    currentRole = "bookkeeper";
    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .send({ status: "on_hold" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("on_hold");
  });
});

describe("employee profile fields (P4-EMP-02)", () => {
  it("round-trips address, email, phone, dates, and SSN", async () => {
    currentRole = "bookkeeper";
    const create = await request(app).post("/api/employees").send({
      name: `${TP} Brendan`,
      address: "123 Main St, Denver, CO 80202",
      email: "brendan@example.com",
      phone: "303-555-0123",
      hireDate: "2024-03-15",
      terminationDate: null,
      ssn: "123-45-6789",
      straightTimeRateCents: 3000,
      overtimeRateCents: 4500,
    });
    expect(create.status).toBe(201);
    expect(create.body.address).toBe("123 Main St, Denver, CO 80202");
    expect(create.body.hireDate).toBe("2024-03-15");
    expect(create.body.ssn).toBe("123-45-6789");

    const patch = await request(app)
      .patch(`/api/employees/${create.body.id}`)
      .send({ terminationDate: "2026-01-31", active: false });
    expect(patch.status).toBe(200);
    expect(patch.body.terminationDate).toBe("2026-01-31");
    expect(patch.body.active).toBe(false);
    expect(patch.body.email).toBe("brendan@example.com");
  });

  it("omits the SSN from the employee list but returns it on the detail endpoint", async () => {
    currentRole = "bookkeeper";
    const create = await request(app).post("/api/employees").send({
      name: `${TP} Ssn Scope`,
      ssn: "987-65-4321",
    });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const list = await request(app).get("/api/employees");
    expect(list.status).toBe(200);
    const row = list.body.find((e: { id: number }) => e.id === id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("ssn");

    const detail = await request(app).get(`/api/employees/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.ssn).toBe("987-65-4321");

    // A PATCH that doesn't mention ssn must not wipe it (list-page edits omit it).
    const patch = await request(app)
      .patch(`/api/employees/${id}`)
      .send({ phone: "303-555-9999" });
    expect(patch.status).toBe(200);
    expect(patch.body.ssn).toBe("987-65-4321");
  });
});
