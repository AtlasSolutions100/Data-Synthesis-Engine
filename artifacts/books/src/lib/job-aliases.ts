import { setJobAliases, getListJobsQueryKey } from "@workspace/api-client-react";
import type { QueryClient } from "@tanstack/react-query";

export type AliasableJob = { id: number; name: string; aliases?: string[] | null };

/** Same normalization the server uses: lower-case, single spaces. */
export function normalizeJobName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when `raw` already resolves to this job by name or alias. */
export function jobKnownAs(job: AliasableJob, raw: string): boolean {
  const key = normalizeJobName(raw);
  if (!key) return true;
  if (normalizeJobName(job.name) === key) return true;
  return (job.aliases ?? []).some((a) => normalizeJobName(a) === key);
}

/**
 * Remember that `raw` (as written on an invoice or time card) means `job`.
 * Best effort: a failure here must never block saving the bill or the run,
 * so errors are swallowed and the jobs list is simply refreshed next time.
 */
export async function rememberJobAlias(
  queryClient: QueryClient,
  job: AliasableJob,
  raw: string,
): Promise<boolean> {
  const alias = raw.trim().replace(/\s+/g, " ");
  if (!alias || alias.length > 120 || jobKnownAs(job, alias)) return false;
  try {
    await setJobAliases(job.id, { aliases: [...(job.aliases ?? []), alias] });
    queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
    return true;
  } catch {
    return false;
  }
}
