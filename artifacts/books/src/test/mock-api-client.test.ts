import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Every test suite that mocks `@workspace/api-client-react` must go through
// the shared factory (`createApiClientReactMock`). Hand-listed mock objects
// silently break when the app gains a new generated data hook ("useX is not
// a function" in an unrelated suite). This scan flags any test file that
// mocks the package without using the factory.
describe("api-client-react mock factory enforcement", () => {
  const SRC_ROOT = join(__dirname, "..");
  const MOCK_CALL = /vi\.mock\(\s*["']@workspace\/api-client-react["']/;

  function collectTestFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectTestFiles(full));
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
    return files;
  }

  function filesMockingApiClient(): string[] {
    return collectTestFiles(SRC_ROOT).filter((file) =>
      MOCK_CALL.test(readFileSync(file, "utf8")),
    );
  }

  it("every test file that mocks @workspace/api-client-react uses createApiClientReactMock", () => {
    const offenders = filesMockingApiClient().filter(
      (file) => !readFileSync(file, "utf8").includes("createApiClientReactMock"),
    );
    expect(offenders).toEqual([]);
  });

  it("sanity check: the scan finds known factory users (jobs.test.tsx)", () => {
    const mockingFiles = filesMockingApiClient();
    expect(mockingFiles.length).toBeGreaterThan(0);
    expect(mockingFiles.some((f) => f.endsWith("pages/jobs.test.tsx"))).toBe(true);
  });
});
