import type { NextRequest } from "next/server";
import { readModelResponse, searchParamsToObject } from "@/lib/readmodels/api";
import { resolvePage, resolveSearchFilters } from "@/lib/readmodels/params";
import { searchCatalogItems } from "@/lib/readmodels/search";

// Bounded catalog search/filter/pagination over PostgreSQL. Always live.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = searchParamsToObject(request.nextUrl);
  return readModelResponse(async (executor) => {
    const filters = resolveSearchFilters(raw);
    const page = resolvePage(raw);
    return {
      filters,
      page: await searchCatalogItems(executor, filters, page)
    };
  });
}
