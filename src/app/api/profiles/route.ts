import { readModelResponse } from "@/lib/readmodels/api";
import { listProfiles } from "@/lib/readmodels/home-feed";

// The household profile roster behind the in-app switcher (RH-0046).
//
// Deliberately its own endpoint rather than an extension of /api/home: the
// switcher must open even when the current session's identity is unresolved
// (unknown/ghost slug → /api/home 404s), and the roster is household-scoped,
// not profile-scoped — mixing it into a profile's feed payload would grow a
// hot payload with data the feed render never uses. The read reuses the
// delivered read-model discipline (shared pool executor, active-only,
// deterministic order, bounded row cap, redacted 503 envelopes); the payload
// exposes at most slug/display name/initials/default flag — never account
// links or credentials. An empty household is a legitimate pre-import state
// and renders as an empty roster, not an error.
export const dynamic = "force-dynamic";

export async function GET() {
  return readModelResponse(async (executor) => {
    const profiles = await listProfiles(executor);
    return {
      profiles: profiles.map(({ slug, display_name, initials, is_default }) => ({
        slug,
        display_name,
        initials,
        is_default
      }))
    };
  });
}
