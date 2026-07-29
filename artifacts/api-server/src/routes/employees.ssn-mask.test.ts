import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { like } from "drizzle-orm";
import { db, employeesTable } from "@workspace/db";

/**
 * Task: keep the SSN masked on the single-employee endpoint by default; the
 * full value is only returned when reveal=true is explicitly passed.
 */

const TP = "TESTSSNMASK";
const FULL_SSN = "123-45-6789";

let app: Express;
let employeeId: number;

async function cleanup(): Promise<void> {
  await db.delete(employeesTable).where(like(employeesTable.name, `${TP}%`));
}

beforeAll(async () => {
  await cleanup();
  const { default: employeesRouter } = await import("./employees");
  app = express();
  app.use(express.json());
  app.use("/api", employeesRouter);

  const [emp] = await db
    .insert(employeesTable)
    .values({ name: `${TP} Alice`, ssn: FULL_SSN })
    .returning();
  employeeId = emp.id;
});

afterAll(cleanup);

describe("GET /employees/:id SSN masking", () => {
  it("masks the SSN by default", async () => {
    const res = await request(app).get(`/api/employees/${employeeId}`);
    expect(res.status).toBe(200);
    expect(res.body.ssn).toBe("•••-••-6789");
    expect(JSON.stringify(res.body)).not.toContain("123-45");
  });

  it("returns the full SSN when reveal=true", async () => {
    const res = await request(app).get(
      `/api/employees/${employeeId}?reveal=true`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ssn).toBe(FULL_SSN);
  });

  it("masks when reveal=false", async () => {
    const res = await request(app).get(
      `/api/employees/${employeeId}?reveal=false`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ssn).toBe("•••-••-6789");
  });

  it("fully masks an SSN with fewer than four digits", async () => {
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `${TP} Bob`, ssn: "12" })
      .returning();
    const res = await request(app).get(`/api/employees/${emp.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ssn).toBe("•••-••-••••");
  });

  it("keeps a null SSN null", async () => {
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `${TP} Carol` })
      .returning();
    const res = await request(app).get(`/api/employees/${emp.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ssn).toBeNull();
  });

  it("PATCH round-trips the SSN and responds masked", async () => {
    const newSsn = "987-65-4321";
    const patch = await request(app)
      .patch(`/api/employees/${employeeId}`)
      .send({ ssn: newSsn });
    expect(patch.status).toBe(200);
    expect(patch.body.ssn).toBe("•••-••-4321");

    const revealed = await request(app).get(
      `/api/employees/${employeeId}?reveal=true`,
    );
    expect(revealed.body.ssn).toBe(newSsn);
  });

  it("POST responds with a masked SSN", async () => {
    const res = await request(app)
      .post("/api/employees")
      .send({ name: `${TP} Dave`, ssn: "555-12-9876" });
    expect(res.status).toBe(201);
    expect(res.body.ssn).toBe("•••-••-9876");
  });
});
