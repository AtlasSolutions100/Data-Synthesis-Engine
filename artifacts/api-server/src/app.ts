import express, { type Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import healthRouter from "./routes/health";
import inboundWebhookRouter from "./routes/inboundWebhook";
import { withCurrentUser } from "./middlewares/currentUser";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

const allowedOrigins = new Set<string>(
  (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => `https://${d}`),
);

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      // Same-origin / server-side / curl requests have no Origin header.
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  }),
);
// 15 MB covers the worst-case base64 inflation of the 10 MB client-side cap
// (~10 MB × 1.33 ≈ 13.3 MB) used for statement file uploads on the
// reconciliation route. Raise both limits together if the cap ever changes.
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// Public health probe — must stay outside the auth gate.
app.use("/api", healthRouter);
// Inbound-mail webhook: the mail provider has no Clerk session, so it sits
// outside the auth gate and is protected by INBOUND_EMAIL_TOKEN instead.
app.use("/api", inboundWebhookRouter);

// `withCurrentUser` is the auth gate: it reads the Clerk session via
// `getAuth(req)` and responds with a JSON 401 when the request is
// unauthenticated. We deliberately do NOT use Clerk's `requireAuth()` here —
// it responds to unauthenticated API requests with a 302 redirect to the
// sign-in page, which the browser's `fetch` silently follows to an HTML page,
// producing non-JSON bodies that crash the client (e.g. "users.map is not a
// function"). A 401 lets react-query surface the error cleanly instead.
app.use("/api", withCurrentUser, router);

// ── Built frontend ──────────────────────────────────────────────────────
// Outside the Replit agent workspace (plain Repl deployments, other hosts)
// there is no separate static service for the Books app, so the API serves
// the Vite build itself: assets from artifacts/books/dist/public and the SPA
// index for every non-API path. Resolved from this file's location so it
// works from the bundled dist/index.mjs; WEB_DIST_DIR overrides it.
const webDistDir = resolveWebDistDir();
if (webDistDir) {
  app.use(
    express.static(webDistDir, {
      index: false,
      // Hashed asset filenames are immutable; index.html must revalidate.
      setHeaders(res, filePath) {
        if (/\/assets\//.test(filePath.replace(/\\/g, "/"))) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );
  app.get(/^(?!\/api(\/|$)).*/, (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(
      path.join(webDistDir, "index.html"),
      { cacheControl: false },
      (err) => {
        if (err) next(err);
      },
    );
  });
  logger.info({ webDistDir }, "Serving Books frontend from API server");
}

export function resolveWebDistDir(): string | null {
  const candidates: string[] = [];
  if (process.env.WEB_DIST_DIR) candidates.push(process.env.WEB_DIST_DIR);
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/index.mjs → ../../books/dist/public ; src/app.ts → ../../books/…
    candidates.push(path.resolve(here, "..", "..", "books", "dist", "public"));
  } catch {
    // CJS test bundles have no import.meta.url; fall through to cwd.
  }
  candidates.push(path.resolve(process.cwd(), "artifacts", "books", "dist", "public"));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

export default app;
