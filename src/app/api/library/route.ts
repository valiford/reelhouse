import { NextResponse } from "next/server";
import { getLibrary } from "@/lib/jellyfin";

export async function GET() {
  return NextResponse.json(await getLibrary());
}
