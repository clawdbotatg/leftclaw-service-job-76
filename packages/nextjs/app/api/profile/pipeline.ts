/**
 * CLAWD Mirror — full backend pipeline skeleton.
 *
 * The static export build ships `route.ts` only (returns 503). When deploying
 * to Vercel as a real Node runtime, replace `route.ts` with a handler that
 * imports `runPipeline` from this file and wire up the env vars listed below.
 *
 * Required env on Vercel:
 *   - OPENAI_API_KEY
 *   - ALCHEMY_API_KEY
 *   - KV_REST_API_URL
 *   - KV_REST_API_TOKEN
 *
 * Pipeline steps:
 *   1. Validate query params (txHash, mode, wallet)
 *   2. Look up cache: key = `mirror:${wallet.toLowerCase()}:${mode}` (24h TTL)
 *      — return cached result with `cached: true` if hit
 *   3. Look up replay set: key = `mirror:tx:${txHash}` — reject if already consumed
 *   4. Verify the on-chain ProfileRequested event via viem:
 *      - createPublicClient({ chain: base, transport: http(alchemyUrl) })
 *      - getTransactionReceipt({ hash: txHash })
 *      - decodeEventLog with MirrorPayment ABI, eventName "ProfileRequested"
 *      - assert event.args.user.toLowerCase() === wallet.toLowerCase()
 *      - assert Number(event.args.mode) === Number(mode)
 *   5. Mark txHash consumed in KV (set with no TTL or 30d TTL)
 *   6. Pull wallet activity from Alchemy:
 *        modes 0,1 (CLAWD focus): CLAWD balance, CLAWD transfer history,
 *          CV balance (if applicable)
 *        modes 2,3 (General focus): all the above + Base txs, ERC20 balances,
 *          NFT holdings, wallet age (first tx timestamp)
 *      Return a `lowConfidence: true` flag for CLAWD mode if the wallet has
 *      no CLAWD activity at all.
 *   7. Call OpenAI GPT-4o with a mode-specific system prompt:
 *        0 = CLAWD Read   (warm personality test)
 *        1 = CLAWD Roast  (savage but about wallet behavior only)
 *        2 = General Read (broad behavioral portrait)
 *        3 = General Roast (full wallet destruction)
 *      Get back: `{ headline, signals: string[], tldr, fullText }`
 *   8. Render share card with @vercel/og + Satori (1200x675 branded template);
 *      upload to KV blob or return a data URL.
 *   9. Cache the result in KV under the wallet:mode key (24h TTL).
 *  10. Return the JSON payload (see ProfileResult type below).
 */

export type Mode = 0 | 1 | 2 | 3;

export type ProfileResult = {
  headline: string;
  tldr: string;
  signals: string[];
  fullText: string;
  imageUrl: string;
  mode: Mode;
  wallet: `0x${string}`;
  txHash: `0x${string}`;
  isClawdPayment: boolean;
  lowConfidence: boolean;
  cached: boolean;
  generatedAt: number;
};

export type PipelineParams = {
  txHash: `0x${string}`;
  mode: Mode;
  wallet: `0x${string}`;
};

// Stub — real implementation lives behind Vercel env vars.
export async function runPipeline(params: PipelineParams): Promise<ProfileResult> {
  throw new Error(
    `runPipeline is a stub (called with mode=${params.mode}, wallet=${params.wallet}, txHash=${params.txHash}). Deploy to Vercel with OPENAI_API_KEY, ALCHEMY_API_KEY and KV_REST_API_* env vars and replace this with the full implementation.`,
  );
}
