export type VendorOption = {
  id: number;
  name: string;
};

export type ExtractedVendorMatch = {
  vendor: VendorOption | null;
  note: string | null;
};

/**
 * Fuzzy-match an extracted vendor name against existing vendors.
 *
 * Match priority (first hit wins, ties go to the next tier):
 *  1. Exact case/whitespace-insensitive match.
 *  2. Unique bidirectional substring match.
 *  3. Initials/acronym match — "CES" matches "City Electric Supply" when
 *     the extracted name is a short ALL-CAPS token and the vendor's first
 *     letters form that acronym. If multiple vendors share the same initials
 *     the user is asked to pick.
 *
 * Multiple candidates or no candidates never pre-select. Never creates vendors.
 */
export function matchExtractedVendor(
  vendors: VendorOption[],
  vendorName: string | null,
): ExtractedVendorMatch {
  if (!vendorName || !vendorName.trim()) {
    return { vendor: null, note: null };
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const target = norm(vendorName);

  // 1. Exact match
  const exact = vendors.filter((v) => norm(v.name) === target);
  if (exact.length === 1) return { vendor: exact[0], note: null };

  // 2. Substring match (either direction)
  const substringCandidates = exact.length
    ? exact
    : vendors.filter(
        (v) =>
          norm(v.name).includes(target) || target.includes(norm(v.name)),
      );
  if (substringCandidates.length === 1) {
    return { vendor: substringCandidates[0], note: null };
  }
  if (substringCandidates.length > 1) {
    return {
      vendor: null,
      note: `Vendor "${vendorName}" on the invoice matches several vendors (e.g. "${substringCandidates[0].name}") — pick the right vendor below.`,
    };
  }

  // 3. Initials / acronym match
  //    Only attempt when the extracted name looks like an acronym: short,
  //    all upper-case letters/digits (2–6 chars), e.g. "CES", "ACME", "HD".
  //    Also handles dotted forms ("C.E.S.") and parenthesised sub-brand
  //    suffixes ("C.E.S. (US Wholesale Division)") by normalising first.
  const trimmed = vendorName.trim();
  // Strip a trailing parenthesised sub-brand suffix, e.g. " (US Wholesale Division)"
  const withoutSuffix = trimmed.replace(/\s*\([^)]*\)\s*$/, "").trim();
  // Strip dots so "C.E.S." → "CES"
  const acronymCandidate = withoutSuffix.replace(/\./g, "");
  if (/^[A-Z0-9]{2,6}$/.test(acronymCandidate)) {
    const acronymTarget = acronymCandidate.toLowerCase();
    const acronymCandidates = vendors.filter((v) => {
      // Build initials from whitespace / punctuation word boundaries
      const initials = norm(v.name)
        .split(/[\s&/,.\-_]+/)
        .filter(Boolean)
        .map((w) => w[0])
        .join("");
      return initials === acronymTarget;
    });
    if (acronymCandidates.length === 1) {
      return {
        vendor: acronymCandidates[0],
        note: `"${vendorName}" recognized as ${acronymCandidates[0].name}.`,
      };
    }
    if (acronymCandidates.length > 1) {
      return {
        vendor: null,
        note: `"${vendorName}" could be ${acronymCandidates
          .map((v) => `"${v.name}"`)
          .join(" or ")} — pick the right vendor below.`,
      };
    }
  }

  return {
    vendor: null,
    note: `Vendor "${vendorName}" was read from the invoice but doesn't match any vendor on file — pick the right vendor below.`,
  };
}
