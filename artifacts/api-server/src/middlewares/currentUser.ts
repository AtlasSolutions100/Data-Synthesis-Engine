import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq, sql } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";
import { logger } from "../lib/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: User;
    }
  }
}

/**
 * Resolves the signed-in Clerk user to a local `users` row, creating it on
 * first sight. The very first user to sign in becomes the owner/admin; everyone
 * after is a bookkeeper. Both roles have full financial access — the role only
 * gates user management. Attaches the row as `req.currentUser`.
 */
export async function withCurrentUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, userId))
      .limit(1);

    if (existing) {
      req.currentUser = existing;
      next();
      return;
    }

    let email: string | null = null;
    let name: string | null = null;
    try {
      const clerkUser = await clerkClient.users.getUser(userId);
      email = clerkUser.primaryEmailAddress?.emailAddress ?? null;
      const fullName = [clerkUser.firstName, clerkUser.lastName]
        .filter(Boolean)
        .join(" ");
      name = fullName || clerkUser.username || null;
    } catch (err) {
      logger.warn({ err }, "Failed to fetch Clerk user details");
    }

    // Serialize the bootstrap decision so concurrent first logins cannot each
    // win the "first user becomes owner" race and create multiple owners.
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('users_bootstrap'))`);

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(usersTable);
      const role = count === 0 ? "owner" : "bookkeeper";

      const [row] = await tx
        .insert(usersTable)
        .values({ clerkUserId: userId, email, name, role })
        .onConflictDoUpdate({
          target: usersTable.clerkUserId,
          set: { email, name },
        })
        .returning();
      return row;
    });

    req.currentUser = created;
    next();
  } catch (err) {
    logger.error({ err }, "withCurrentUser middleware failed");
    res.status(500).json({ error: "Failed to resolve current user" });
  }
}

/** Restricts a route to owner/admin users. Requires `withCurrentUser` first. */
export function requireOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.currentUser?.role !== "owner") {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  next();
}
