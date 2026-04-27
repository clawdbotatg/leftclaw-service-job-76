import { NextResponse } from "next/server";

// Force static so this can ship inside a Next.js `output: "export"` build
// (the IPFS build). When deployed to Vercel as a real Node runtime, swap this
// stub for the full pipeline in `./pipeline.ts` and remove `force-static`.
export const dynamic = "force-static";

export async function GET() {
  return NextResponse.json(
    {
      error:
        "CLAWD Mirror backend is not configured on this host. Deploy the project to Vercel and wire up OPENAI_API_KEY, ALCHEMY_API_KEY, and KV_REST_API_* env vars to enable profile generation.",
      setupRequired: true,
    },
    { status: 503 },
  );
}
