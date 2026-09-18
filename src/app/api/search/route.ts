import { NextRequest, NextResponse } from "next/server";
import { searchLibrary } from "@/lib/jellyfin";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") || "";
  return NextResponse.json({ items: await searchLibrary(q) });
}
