# 🪞 CLAWD Mirror

> Pay $0.05 in ETH or CLAWD on Base. Get a shareable wallet personality profile.

CLAWD Mirror is a 2x2 wallet characterization service:

|         | **Read Me** (warm)     | **Roast Me** (savage)        |
| ------- | ---------------------- | ---------------------------- |
| CLAWD   | mode 0 — staking vibes | mode 1 — paper-hands roast   |
| General | mode 2 — broad portrait| mode 3 — full destruction    |

Payment is settled on-chain via the `MirrorPayment` contract on Base mainnet.
The frontend then polls a Vercel API route that:

1. Verifies the on-chain `ProfileRequested` event
2. Pulls wallet activity from Alchemy
3. Sends the data to GPT-4o with a mode-specific system prompt
4. Renders a 1200x675 share card with `@vercel/og`
5. Caches the result in Vercel KV (24h TTL keyed by `${wallet}:${mode}`)

## Contracts

| Contract        | Network | Address                                       |
| --------------- | ------- | --------------------------------------------- |
| `MirrorPayment` | Base    | `0xA84611277203DBe66631b5227CAd3a46a7D0934c`  |
| `CLAWD`         | Base    | `0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07`  |

The MirrorPayment contract uses the Chainlink ETH/USD feed plus an L2 sequencer
uptime check so the ETH price is always pegged to $0.05 USD. CLAWD price is
owner-configurable.

## Repo Layout

```
packages/
├─ foundry/   # MirrorPayment.sol + Foundry deploy scripts
└─ nextjs/    # Frontend + Vercel API route
   ├─ app/page.tsx                  # Three-state UI (input → loading → result)
   ├─ app/api/profile/route.ts      # 503 stub for static export
   ├─ app/api/profile/pipeline.ts   # Full backend skeleton (Vercel deploy)
   └─ contracts/                    # deployedContracts + externalContracts (CLAWD)
```

## Local Dev

```bash
yarn install
yarn start    # next dev on :3000
```

Set `NEXT_PUBLIC_ALCHEMY_API_KEY` in `packages/nextjs/.env.local` to avoid Alchemy
rate limits.

## Static Export (IPFS)

```bash
NEXT_PUBLIC_ALCHEMY_API_KEY=<your-key> NEXT_PUBLIC_IPFS_BUILD=true yarn build
# Output: packages/nextjs/out/
```

The static build ships only the 503 stub for `/api/profile`. To run the full
pipeline, deploy to Vercel and replace `route.ts` with a handler that calls
`runPipeline` from `pipeline.ts`. Required env on Vercel:

- `OPENAI_API_KEY`
- `ALCHEMY_API_KEY`
- `KV_REST_API_URL` and `KV_REST_API_TOKEN`

## Contract Verification

```bash
yarn verify --network base
```

## License

MIT
