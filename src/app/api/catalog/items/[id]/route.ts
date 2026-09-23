import { readModelResponse } from "@/lib/readmodels/api";
import { resolveIdentifier } from "@/lib/readmodels/params";
import { getCatalogItem } from "@/lib/readmodels/search";

// Catalog item detail (facets, file state, provenance stamps) by Jellyfin id.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return readModelResponse(async (executor) => {
    resolveIdentifier(id, "item id");
    return getCatalogItem(executor, id);
  });
}
