import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { cleanupDuplicateClerkCookies } from "./lib/clerk-cookie-cleanup";

// Must run before Clerk initializes: duplicated Clerk cookies (stale copies
// on a different path/domain scope) shadow the fresh session cookie and make
// the API reject every request with 401 Unauthorized.
cleanupDuplicateClerkCookies(import.meta.env.BASE_URL.replace(/\/$/, ""));

createRoot(document.getElementById("root")!).render(<App />);
