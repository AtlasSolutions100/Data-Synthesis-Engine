import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, usersTable, jobDocumentsTable, type User } from "@workspace/db";
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
 * only when Clerk reports it as verified. Used for merging duplicate logins —
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
    logger.warn({ err }, "Failed to fetch Clerk user for duplicate-login merge");
    return null;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Picks the row to keep when several rows belong to the same person:
 * prefer an owner row (so the role survives), otherwise the oldest row.
 */
function pickKeeper(rows: User[]): User {
  const owners = rows.filter((r) => r.role === "owner");
  const pool = owners.length > 0 ? owners : rows;
  return pool.reduce((a, b) => (a.id <= b.id ? a : b));
}

/**
 * Merges duplicate user rows for one person into `keeper`: repoints foreign
 * keys off the losing rows, deletes them, and repoints the keeper at the
 * clerkUserId that is signing in right now. Returns the updated keeper.
 * Must run inside a transaction.
 */
async function mergeUserRows(
  tx: Tx,
  keeper: User,
  losers: User[],
  clerkUserId: string,
): Promise<User> {
  const anyOwner =
    keeper.role === "owner" || losers.some((r) => r.role === "owner");
  if (losers.length > 0) {
    const loserIds = losers.map((r) => r.id);
    await tx
      .update(jobDocumentsTable)
      .set({ uploadedByUserId: keeper.id })
      .where(inArray(jobDocumentsTable.uploadedByUserId, loserIds));
    await tx.delete(usersTable).where(inArray(usersTable.id, loserIds));
  }
  const [updated] = await tx
    .update(usersTable)
    .set({
      clerkUserId,
      role: anyOwner ? "owner" : keeper.role,
    })
    .where(eq(usersTable.id, keeper.id))
    .returning();
  return updated ?? keeper;
}

/**
 * Resolves the signed-in Clerk user to a local `users` row, creating it on
 * first sight. The very first user to sign in becomes the owner/admin; everyone
 * after is a bookkeeper. Both roles have full financial access — the role only
 * gates user management.
 *
 * Duplicate-login handling: the same person can arrive with a new clerkUserId
 * (different sign-in method, or Clerk dev keys → production keys). Rows are
 * merged by *verified* Clerk email so each person keeps exactly one row:
 * - On first sight, a new login whose verified email matches existing row(s)
 *   adopts the existing row instead of inserting a duplicate.
 * - On later sign-ins, any leftover rows with the same verified email are
 *   merged into one (preferring the owner row, so owner access survives).
 * The email must come fresh from Clerk and be verified; never trust the
 * stored DB value for an authorization decision.
 *
 * Attaches the row as `req.currentUser`.
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
      // Decide whether to consult Clerk for the verified email. Non-owner
      // logins always check (their row may need to merge into an owner row —
      // the owner self-heal). Owner logins only check when a stored-email
      // twin suggests a leftover duplicate, to avoid a Clerk API call on
      // every request.
      let shouldCheck = existing.role !== "owner";
      if (!shouldCheck && existing.email) {
        const [candidate] = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            and(
              sql`lower(${usersTable.email}) = ${normalizeEmail(existing.email)}`,
              ne(usersTable.id, existing.id),
            ),
          )
          .limit(1);
        shouldCheck = Boolean(candidate);
      }

      if (shouldCheck) {
        const verifiedEmail = await getVerifiedClerkEmail(userId);
        if (verifiedEmail) {
          const twins = await db
            .select()
            .from(usersTable)
            .where(
              and(
                sql`lower(${usersTable.email}) = ${verifiedEmail}`,
                ne(usersTable.id, existing.id),
              ),
            );
          if (twins.length > 0) {
            const rows = [existing, ...twins];
            const keeper = pickKeeper(rows);
            const losers = rows.filter((r) => r.id !== keeper.id);
            const merged = await db.transaction(async (tx) => {
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtext('users_bootstrap'))`,
              );
              return mergeUserRows(tx, keeper, losers, userId);
            });
            req.currentUser = merged;
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

      // First sight of this clerkUserId: if row(s) with the same *verified*
      // email already exist, this is an existing person arriving via a new
      // Clerk account — reuse (merge into) their row instead of inserting a
      // duplicate.
      if (verifiedEmail) {
        const twins = await tx
          .select()
          .from(usersTable)
          .where(sql`lower(${usersTable.email}) = ${verifiedEmail}`);
        if (twins.length > 0) {
          const keeper = pickKeeper(twins);
          const losers = twins.filter((r) => r.id !== keeper.id);
          const merged = await mergeUserRows(tx, keeper, losers, userId);
          // Refresh profile fields from the current Clerk account.
          const [refreshed] = await tx
            .update(usersTable)
            .set({ email, name: name ?? merged.name })
            .where(eq(usersTable.id, merged.id))
            .returning();
          return refreshed ?? merged;
        }
      }

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(usersTable);
      const role: "owner" | "bookkeeper" = count === 0 ? "owner" : "bookkeeper";

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
