/**
 * One-time cleanup for duplicated Clerk cookies.
 *
 * Clerk's dev-instance cookies (`__session`, `__client_uat`, `__clerk_db_jwt`
 * and their key-suffixed variants) can end up duplicated in the browser with
 * different Path/Domain scopes (e.g. one at "/" and one at "/books", or a
 * host-only copy alongside a domain-wide copy). When that happens the browser
 * sends BOTH copies; the API server reads the first (stale) one and rejects
 * every request with 401 even though the client believes it is signed in.
 *
 * When duplicates are detected, expire every scope variant we can reach so
 * Clerk re-establishes a single clean set. The user may need to sign in once
 * more afterwards — far better than a permanently unauthorized session.
 */
export function cleanupDuplicateClerkCookies(basePath: string): void {
  const names = document.cookie
    .split(";")
    .map((c) => c.split("=")[0]?.trim())
    .filter(Boolean);

  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);

  const isClerkCookie = (name: string) =>
    name === "__session" ||
    name === "__client_uat" ||
    name === "__clerk_db_jwt" ||
    name.startsWith("__session_") ||
    name.startsWith("__client_uat_") ||
    name.startsWith("__clerk_db_jwt_");

  const duplicated = [...counts.entries()]
    .filter(([name, count]) => count > 1 && isClerkCookie(name))
    .map(([name]) => name);

  if (duplicated.length === 0) return;

  // Expire every Clerk cookie (not just the duplicated names) across all
  // plausible path/domain scopes, so the surviving set is consistent.
  const clerkNames = [...new Set(names.filter(isClerkCookie))];
  const hostname = window.location.hostname;
  const paths = new Set<string>(["/"]);
  if (basePath) {
    paths.add(basePath);
    paths.add(`${basePath}/`);
  }
  // Also cover each ancestor segment of the current path.
  const segments = window.location.pathname.split("/").filter(Boolean);
  let acc = "";
  for (const seg of segments) {
    acc += `/${seg}`;
    paths.add(acc);
    paths.add(`${acc}/`);
  }
  const domains = ["", hostname, `.${hostname}`];

  const expired = "Thu, 01 Jan 1970 00:00:00 GMT";
  for (const name of clerkNames) {
    for (const path of paths) {
      for (const domain of domains) {
        const domainPart = domain ? `; domain=${domain}` : "";
        document.cookie = `${name}=; expires=${expired}; path=${path}${domainPart}; SameSite=None; Secure`;
        document.cookie = `${name}=; expires=${expired}; path=${path}${domainPart}`;
      }
    }
  }

  // eslint-disable-next-line no-console
  console.warn(
    `Cleared duplicated Clerk cookies (${duplicated.join(", ")}); you may need to sign in again.`,
  );
}
