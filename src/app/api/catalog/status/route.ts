import { readModelResponse } from "@/lib/readmodels/api";
import { catalogStatus } from "@/lib/readmodels/freshness";

// Catalog freshness + degraded-state surface: how old the newest successful
// sync is, what the watermark/counters/quarantines say, and how fresh the
// household import is. Compose with /api/health's Jellyfin probe to render
// degraded-Jellyfin banners.
export const dynamic = "force-dynamic";

export async function GET() {
  return readModelResponse(async (executor) => catalogStatus(executor));
}
