// Common given names used to spot fields that actually contain a person's
// name (e.g. a supervisor or foreman) rather than a job. Per convention,
// any person-like extracted job name must be explicitly confirmed against
// the job list, even if a job with the same name exists.
export const COMMON_GIVEN_NAMES = new Set(
  (
    "james john robert michael william david richard joseph thomas charles " +
    "christopher daniel matthew anthony mark donald steven paul andrew joshua " +
    "kenneth kevin brian george timothy ronald edward jason jeffrey ryan " +
    "jacob gary nicholas eric jonathan stephen larry justin scott brandon " +
    "benjamin samuel gregory alexander frank patrick raymond jack dennis " +
    "jerry tyler aaron jose adam nathan henry peter zachary douglas kyle " +
    "noah alan ethan jeremy walter christian keith roger terry austin sean " +
    "gerald carl harold dylan arthur lawrence jordan jesse bryan billy " +
    "bruce gabriel joe logan albert willie elijah wayne randy vincent mason " +
    "roy ralph bobby russell bradley philip eugene louis phillip brendan " +
    "mary patricia jennifer linda elizabeth barbara susan jessica sarah " +
    "karen lisa nancy betty sandra margaret ashley kimberly emily donna " +
    "michelle carol amanda dorothy melissa deborah stephanie rebecca sharon " +
    "laura cynthia kathleen amy angela shirley anna brenda pamela emma " +
    "nicole helen samantha katherine christine debra rachel carolyn janet " +
    "catherine maria heather diane ruth julie olivia joyce virginia victoria " +
    "kelly lauren christina joan evelyn judith megan andrea cheryl hannah " +
    "jacqueline martha gloria teresa ann sara madison frances kathryn janice " +
    "jean abigail alice julia judy sophia grace denise amber doris marilyn " +
    "danielle beverly isabella theresa diana natalie brittany charlotte " +
    "griselda tracy"
  ).split(/\s+/),
);

/**
 * Heuristic: a 2–3 word alphabetic string whose first word is a common given
 * name looks like a person's name, not a job.
 */
export function looksLikePersonName(raw: string): boolean {
  const words = raw.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  if (!words.every((w) => /^[A-Za-z][A-Za-z'.-]*$/.test(w))) return false;
  return COMMON_GIVEN_NAMES.has(words[0].toLowerCase());
}
