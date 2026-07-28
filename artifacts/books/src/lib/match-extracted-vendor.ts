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
 * Pre-select only on a unique match: an exact (case/whitespace-insensitive)
 * match wins outright; otherwise a unique substring match either way.
 * Multiple candidates or no candidates never pre-select — the user is
 * asked to pick the right vendor instead. Never creates vendors.
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
  const exact = vendors.filter((v) => norm(v.name) === target);
  if (exact.length === 1) {
    return { vendor: exact[0], note: null };
  }
  const candidates = exact.length
    ? exact
    : vendors.filter(
        (v) =>
          norm(v.name).includes(target) || target.includes(norm(v.name)),
      );
  if (candidates.length === 1) {
    return { vendor: candidates[0], note: null };
  }
  if (candidates.length > 1) {
    return {
      vendor: null,
      note: `Vendor "${vendorName}" on the invoice matches several vendors (e.g. "${candidates[0].name}") — pick the right vendor below.`,
    };
  }
  return {
    vendor: null,
    note: `Vendor "${vendorName}" was read from the invoice but doesn't match any vendor on file — pick the right vendor below.`,
  };
}
