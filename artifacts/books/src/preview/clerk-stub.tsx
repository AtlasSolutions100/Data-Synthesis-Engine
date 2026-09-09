/**
 * Design-preview stand-in for `@clerk/react`. Only used when Vite runs with
 * VITE_PREVIEW=1 (see vite.config.ts alias), so pages can render in a
 * browser without a Clerk session for visual review. Never bundled into the
 * real app.
 */
import type { ReactNode } from "react";

const previewUser = {
  id: "user_preview",
  firstName: "Mike",
  lastName: "Allied",
  fullName: "Mike Allied",
  emailAddresses: [{ emailAddress: "mike@alliedpowerservices.com" }],
};

export function ClerkProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function useUser() {
  return { isLoaded: true, isSignedIn: true, user: previewUser };
}
export function useClerk() {
  return { signOut: async () => {}, loaded: true };
}
export function useAuth() {
  return { isLoaded: true, isSignedIn: true, userId: previewUser.id, getToken: async () => null };
}
export function Show({ children }: { children: ReactNode; when?: unknown }) {
  return <>{children}</>;
}
export function SignIn() {
  return <div>Sign in (preview)</div>;
}
export function SignUp() {
  return <div>Sign up (preview)</div>;
}
