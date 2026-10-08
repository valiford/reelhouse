import { Suspense } from "react";
import ReelHouseApp from "@/components/ReelHouseApp";

// The app reads the live ?profile= identity through useSearchParams
// (RH-0043), which opts the client shell into dynamic param reading — the
// Suspense boundary carries the static prerender.
export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="content-rail" aria-hidden>
          <div className="skeleton-hero" />
        </div>
      }
    >
      <ReelHouseApp />
    </Suspense>
  );
}
