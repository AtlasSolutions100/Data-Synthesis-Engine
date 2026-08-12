import { Badge } from "@/components/ui/badge";

/**
 * Small "Demo" badge rendered next to demo-data records in list views.
 * Only shown when `isDemo` is true; renders nothing otherwise.
 */
export function DemoBadge({ isDemo }: { isDemo?: boolean }) {
  if (!isDemo) return null;
  return (
    <Badge
      variant="outline"
      className="text-xs border-amber-400 text-amber-600 bg-amber-50 shrink-0"
      data-testid="badge-demo"
    >
      Demo
    </Badge>
  );
}
