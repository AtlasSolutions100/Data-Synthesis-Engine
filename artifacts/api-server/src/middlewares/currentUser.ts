import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { and, eq, ne, sql } from "drizzle-orm";
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Fetches the user's primary email from Clerk and returns it (normalized)
 * only when Clerk reports it as verified. Used for the owner self-heal —
 * an authorization decision must never rely on an unverified or stored email.
 */
async function getVerifiedClerkEmail(userId: string): Promise<string | null> {
  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    const primary = clerkUser.primaryEmailAddress;
    if (!primary?.emailAddress) return null;
    if (primary.verification?.status !== "verified") return null;
    return normalizeEmail(primary.emailAddress);
  } catch (err) {
    logger.warn({ err }, "Failed to fetch Clerk user for owner self-heal");
    return null;
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
      // TEMP DEBUG: diagnose blanket 401s — log what Clerk actually received.
      if (process.env.NODE_ENV !== "production") {
        const cookieHeader = req.headers.cookie ?? "";
        logger.warn(
          {
            url: req.originalUrl,
            auth: getAuth(req),
            authStatus: (req as any).auth?.() ?? (req as any).auth,
            hasCookieHeader: Boolean(cookieHeader),
            cookieNames: cookieHeader
              .split(";")
              .map((c) => c.split("=")[0]?.trim())
              .filter(Boolean),
            hasAuthorization: Boolean(req.headers.authorization),
            host: req.headers.host,
            xForwardedHost: req.headers["x-forwarded-host"],
          },
          "401 debug: unauthenticated API request",
        );
      }
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, userId))
      .limit(1);

    if (existing) {
      // Self-heal: Clerk instances can change (e.g. dev keys → production
      // keys), giving the same person a new clerkUserId. If this login was
      // created as a bookkeeper but another row with the same *verified*
      // email is the owner, this is the owner signing in from a new Clerk
      // account — promote the new row so owner-only features stay
      // accessible. The email must come fresh from Clerk and be verified;
      // never trust the stored DB value for an authorization decision.
      if (existing.role !== "owner") {
        const verifiedEmail = await getVerifiedClerkEmail(userId);
        if (verifiedEmail) {
          const [ownerTwin] = await db
            .select({ id: usersTable.id })
            .from(usersTable)
            .where(
              and(
                sql`lower(${usersTable.email}) = ${verifiedEmail}`,
                eq(usersTable.role, "owner"),
                ne(usersTable.clerkUserId, userId),
              ),
            )
            .limit(1);
          if (ownerTwin) {
            const [promoted] = await db
              .update(usersTable)
              .set({ role: "owner" })
              .where(
                and(eq(usersTable.id, existing.id), ne(usersTable.role, "owner")),
              )
              .returning();
            req.currentUser = promoted ?? existing;
            next();
            return;
          }
        }
      }
      req.currentUser = existing;
      next();
      return;
    }

    let email: string | null = null;
    let verifiedEmail: string | null = null;
    let name: string | null = null;
    try {
      const clerkUser = await clerkClient.users.getUser(userId);
      const primary = clerkUser.primaryEmailAddress;
      email = primary?.emailAddress ?? null;
      verifiedEmail =
        primary?.verification?.status === "verified"
          ? normalizeEmail(primary.emailAddress)
          : null;
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
      let role: "owner" | "bookkeeper" = count === 0 ? "owner" : "bookkeeper";

      // Same self-heal as above, applied at creation time: a *verified*
      // email that already belongs to an owner row means this is the owner
      // arriving via a new Clerk account.
      if (role !== "owner" && verifiedEmail) {
        const [ownerTwin] = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            and(
              sql`lower(${usersTable.email}) = ${verifiedEmail}`,
              eq(usersTable.role, "owner"),
            ),
          )
          .limit(1);
        if (ownerTwin) role = "owner";
      }

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
