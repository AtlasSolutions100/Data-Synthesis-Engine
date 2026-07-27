import { looksLikePersonName } from "@/lib/person-name";

export type JobOption = {
  id: number;
  name: string;
  poNumber?: string | null;
  customerId?: number | null;
};

export type ExtractedJobMatch = {
  job: JobOption | null;
  confident: boolean;
  note: string | null;
};

/**
 * Fuzzy-match an extracted job name / PO number against existing jobs.
 * Pre-select (confident) only on a unique PO-number match or a unique
 * name match that doesn't look like a person's name — person-like job
 * names always require explicit confirmation. Never creates jobs.
 */
export function matchExtractedJob(
  jobs: JobOption[],
  jobName: string | null,
  poNumber: string | null,
): ExtractedJobMatch {
  const norm = (s: string) => s.trim().toLowerCase();
  if (poNumber) {
    const poMatches = jobs.filter(
      (j) => j.poNumber && norm(j.poNumber) === norm(poNumber),
    );
    if (poMatches.length === 1) {
      return { job: poMatches[0], confident: true, note: null };
    }
    if (poMatches.length > 1) {
      return {
        job: null,
        confident: false,
        note: `PO number "${poNumber}" on the invoice matches several jobs — pick the right job below.`,
      };
    }
  }
  if (!jobName) {
    if (poNumber) {
      return {
        job: null,
        confident: false,
        note: `PO number "${poNumber}" on the invoice doesn't match any job on file — pick the job below if one applies.`,
      };
    }
    return { job: null, confident: false, note: null };
  }
  const personLike = looksLikePersonName(jobName);
  const exact = jobs.filter((j) => norm(j.name) === norm(jobName));
  const fuzzy = exact.length
    ? exact
    : jobs.filter(
        (j) =>
          norm(j.name).includes(norm(jobName)) ||
          norm(jobName).includes(norm(j.name)),
      );
  if (fuzzy.length === 1 && !personLike) {
    return { job: fuzzy[0], confident: true, note: null };
  }
  if (fuzzy.length >= 1 && personLike) {
    return {
      job: fuzzy[0],
      confident: false,
      note: `Job "${jobName}" was read from the invoice, but it looks like a person's name — it may match "${fuzzy[0].name}"; confirm the job below.`,
    };
  }
  if (fuzzy.length > 1) {
    return {
      job: fuzzy[0],
      confident: false,
      note: `Job "${jobName}" on the invoice matches several jobs (e.g. "${fuzzy[0].name}") — pick the right job below.`,
    };
  }
  return {
    job: null,
    confident: false,
    note: `Job "${jobName}" was read from the invoice but doesn't match any job on file — pick the job below if one applies.`,
  };
}
