import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  ListUsersResponse,
  GetCurrentUserResponse,
  UpdateUserRoleParams,
  UpdateUserRoleBody,
  DeleteUserParams,
} from "@workspace/api-zod";
import { requireOwner } from "../middlewares/currentUser";

const router: IRouter = Router();

router.get("/users/me", async (req, res): Promise<void> => {
  res.json(GetCurrentUserResponse.parse(req.currentUser));
});

router.get("/users", requireOwner, async (_req, res): Promise<void> => {
  const rows = await db.select().from(usersTable).orderBy(usersTable.id);
  res.json(ListUsersResponse.parse(rows));
});

router.patch(
  "/users/:id",
  requireOwner,
  async (req, res): Promise<void> => {
    const params = UpdateUserRoleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateUserRoleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    // Prevent removing the last owner so the company never loses admin access.
    if (
      parsed.data.role !== "owner" &&
      req.currentUser?.id === params.data.id
    ) {
      res
        .status(400)
        .json({ error: "You cannot remove your own owner access" });
      return;
    }

    const [row] = await db
      .update(usersTable)
      .set({ role: parsed.data.role })
      .where(eq(usersTable.id, params.data.id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(GetCurrentUserResponse.parse(row));
  },
);

router.delete(
  "/users/:id",
  requireOwner,
  async (req, res): Promise<void> => {
    const params = DeleteUserParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (req.currentUser?.id === params.data.id) {
      res.status(400).json({ error: "You cannot remove yourself" });
      return;
    }
    const [row] = await db
      .delete(usersTable)
      .where(eq(usersTable.id, params.data.id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.sendStatus(204);
  },
);

export default router;
