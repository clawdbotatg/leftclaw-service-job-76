"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { type Address as AddressType, formatEther, formatUnits } from "viem";
import { base } from "viem/chains";
import {
  useAccount,
  useBalance,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import deployedContracts from "~~/contracts/deployedContracts";
import externalContracts from "~~/contracts/externalContracts";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";
import { getParsedErrorWithAllAbis } from "~~/utils/scaffold-eth/contract";

// ----- Domain types -----

type Mode = 0 | 1 | 2 | 3;
type Focus = "CLAWD" | "General";
type Tone = "Read" | "Roast";
type PaymentMode = "ETH" | "CLAWD";

type ProfileResult = {
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

type Pipeline =
  | { status: "input" }
  | { status: "submitting" }
  | { status: "loading"; txHash: `0x${string}`; mode: Mode; wallet: `0x${string}` }
  | { status: "result"; result: ProfileResult }
  | { status: "error"; message: string };

// ----- Constants -----

const APPROVE_COOLDOWN_MS = 4_000;
const POLL_INTERVAL_MS = 2_000;
const APPROVE_FAILSAFE_MS = 60_000;

const MIRROR_PAYMENT_ADDRESS = deployedContracts[8453].MirrorPayment.address as AddressType;
const CLAWD_ADDRESS = externalContracts[8453].CLAWD.address as AddressType;
const CLAWD_ABI = externalContracts[8453].CLAWD.abi;

const LOADING_STATES_BY_MODE: Record<Mode, string[]> = {
  0: [
    "Reading your staking energy...",
    "Measuring your conviction...",
    "Decoding your chain personality...",
    "Listening to what your wallet whispers...",
  ],
  1: [
    "Sharpening the knives...",
    "Studying your paper hands...",
    "Loading the roast...",
    "Judging your conviction score...",
  ],
  2: [
    "Scanning your chain footprint...",
    "Decoding your transaction patterns...",
    "Building your profile...",
    "Surveying every contract you ever touched...",
  ],
  3: [
    "Loading the insults...",
    "Judging your token choices...",
    "Preparing the destruction...",
    "Counting your rugs...",
  ],
};

const focusToneToMode = (focus: Focus, tone: Tone): Mode => {
  if (focus === "CLAWD" && tone === "Read") return 0;
  if (focus === "CLAWD" && tone === "Roast") return 1;
  if (focus === "General" && tone === "Read") return 2;
  return 3;
};

// ----- Helpers -----

const isMobileDevice = (): boolean => {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

const openMobileWallet = (): void => {
  if (!isMobileDevice()) return;
  try {
    const lastUsed =
      typeof window !== "undefined" && window.localStorage
        ? window.localStorage.getItem("WALLETCONNECT_DEEPLINK_CHOICE")
        : null;
    if (lastUsed) {
      const parsed = JSON.parse(lastUsed) as { href?: string };
      if (parsed?.href) window.location.href = parsed.href;
    }
  } catch {
    // ignore
  }
};

// Tiny markdown renderer — bold (**text**) and paragraphs only. Avoids pulling
// in a markdown lib for what the OpenAI output will reasonably contain.
const renderMarkdown = (text: string): string => {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const withBold = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const withItalic = withBold.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  const paragraphs = withItalic
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return paragraphs;
};

const Home: NextPage = () => {
  const { address: connectedAddress, chain: connectedChain, isConnected } = useAccount();
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain();
  const onWrongNetwork = isConnected && connectedChain?.id !== base.id;

  const [focus, setFocus] = useState<Focus>("CLAWD");
  const [tone, setTone] = useState<Tone>("Read");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("ETH");
  const [pipeline, setPipeline] = useState<Pipeline>({ status: "input" });
  const [loadingTextIndex, setLoadingTextIndex] = useState(0);
  const [approveSubmitting, setApproveSubmitting] = useState(false);
  const [approveCooldownUntil, setApproveCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approveFailsafeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mode = useMemo(() => focusToneToMode(focus, tone), [focus, tone]);

  const clearApproveFailsafe = useCallback(() => {
    if (approveFailsafeRef.current) {
      clearTimeout(approveFailsafeRef.current);
      approveFailsafeRef.current = null;
    }
  }, []);

  // cleanup
  useEffect(() => {
    return () => {
      if (approveFailsafeRef.current) {
        clearTimeout(approveFailsafeRef.current);
        approveFailsafeRef.current = null;
      }
    };
  }, []);

  // ------- Reads -------
  const { data: ethRequiredWei } = useScaffoldReadContract({
    contractName: "MirrorPayment",
    functionName: "ethRequired",
    watch: true,
  });

  const { data: queryPriceClawd } = useScaffoldReadContract({
    contractName: "MirrorPayment",
    functionName: "queryPriceCLAWD",
  });

  const { data: ethBalanceData } = useBalance({
    address: connectedAddress,
    chainId: base.id,
    query: { enabled: Boolean(connectedAddress) },
  });

  const { data: clawdBalanceRaw, refetch: refetchClawdBalance } = useReadContract({
    abi: CLAWD_ABI,
    address: CLAWD_ADDRESS,
    chainId: base.id,
    functionName: "balanceOf",
    args: connectedAddress ? [connectedAddress] : undefined,
    query: { enabled: Boolean(connectedAddress) },
  });

  const { data: clawdAllowanceRaw, refetch: refetchClawdAllowance } = useReadContract({
    abi: CLAWD_ABI,
    address: CLAWD_ADDRESS,
    chainId: base.id,
    functionName: "allowance",
    args: connectedAddress ? [connectedAddress, MIRROR_PAYMENT_ADDRESS] : undefined,
    query: { enabled: Boolean(connectedAddress) },
  });

  const { data: clawdDecimalsRaw } = useReadContract({
    abi: CLAWD_ABI,
    address: CLAWD_ADDRESS,
    chainId: base.id,
    functionName: "decimals",
  });

  const clawdDecimals = clawdDecimalsRaw !== undefined ? Number(clawdDecimalsRaw) : 18;
  const clawdBalance = (clawdBalanceRaw as bigint | undefined) ?? 0n;
  const clawdAllowance = (clawdAllowanceRaw as bigint | undefined) ?? 0n;
  const requiredClawd = (queryPriceClawd as bigint | undefined) ?? 0n;
  const requiredEth = (ethRequiredWei as bigint | undefined) ?? 0n;
  const ethBalance = ethBalanceData?.value ?? 0n;

  const needsApproval = paymentMode === "CLAWD" && requiredClawd > 0n && clawdAllowance < requiredClawd;

  const insufficientFunds = useMemo(() => {
    if (paymentMode === "ETH") return requiredEth > 0n && ethBalance < requiredEth;
    return requiredClawd > 0n && clawdBalance < requiredClawd;
  }, [paymentMode, requiredEth, ethBalance, requiredClawd, clawdBalance]);

  // ------- Writes -------
  const { writeContractAsync: approveClawd } = useWriteContract();
  const { writeContractAsync: writeQuery, isMining } = useScaffoldWriteContract({
    contractName: "MirrorPayment",
  });

  // Approve cooldown ticker
  useEffect(() => {
    if (approveCooldownUntil <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [approveCooldownUntil]);

  const inApproveCooldown = approveCooldownUntil > now;

  // Loading text rotation
  useEffect(() => {
    if (pipeline.status !== "loading") return;
    const id = setInterval(() => {
      setLoadingTextIndex(i => (i + 1) % LOADING_STATES_BY_MODE[pipeline.mode].length);
    }, 2_500);
    return () => clearInterval(id);
  }, [pipeline]);

  // Result polling
  useEffect(() => {
    if (pipeline.status !== "loading") {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "";
    const url = `${apiBase}/api/profile?txHash=${pipeline.txHash}&mode=${pipeline.mode}&wallet=${pipeline.wallet}`;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as ProfileResult;
          setPipeline({ status: "result", result: data });
          return;
        }
        if (res.status === 503) {
          const body = (await res.json()) as { error?: string };
          setPipeline({
            status: "error",
            message:
              body.error || "Backend not configured. Your on-chain payment succeeded; the analysis service is offline.",
          });
        }
        // any other status: keep polling silently — backend may still be working
      } catch {
        // network blip — keep polling
      }
    };

    poll();
    pollIntervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [pipeline]);

  // ------- Approve handler -------
  const [pendingApproveTx, setPendingApproveTx] = useState<`0x${string}` | undefined>();
  const { data: approveReceipt } = useWaitForTransactionReceipt({
    hash: pendingApproveTx,
    chainId: base.id,
    query: { enabled: Boolean(pendingApproveTx) },
  });

  useEffect(() => {
    if (!approveReceipt) return;
    clearApproveFailsafe();
    setApproveSubmitting(false);
    setApproveCooldownUntil(Date.now() + APPROVE_COOLDOWN_MS);
    refetchClawdAllowance();
    notification.success("CLAWD approved.");
    setPendingApproveTx(undefined);
  }, [approveReceipt, clearApproveFailsafe, refetchClawdAllowance]);

  const handleApprove = useCallback(async () => {
    if (!connectedAddress || !needsApproval) return;
    setApproveSubmitting(true);
    clearApproveFailsafe();
    approveFailsafeRef.current = setTimeout(() => {
      setApproveSubmitting(false);
      approveFailsafeRef.current = null;
    }, APPROVE_FAILSAFE_MS);
    try {
      const hash = await approveClawd({
        abi: CLAWD_ABI,
        address: CLAWD_ADDRESS,
        chainId: base.id,
        functionName: "approve",
        args: [MIRROR_PAYMENT_ADDRESS, requiredClawd],
      });
      setTimeout(openMobileWallet, 2_000);
      notification.success("Approval submitted. Waiting for confirmation...");
      setPendingApproveTx(hash);
    } catch (err) {
      const parsed = getParsedErrorWithAllAbis(err, base.id);
      notification.error(parsed);
      clearApproveFailsafe();
      setApproveSubmitting(false);
    }
  }, [approveClawd, clearApproveFailsafe, connectedAddress, needsApproval, requiredClawd]);

  // ------- Submit handler -------
  const handleSubmit = useCallback(async () => {
    if (!connectedAddress) return;
    if (onWrongNetwork) {
      notification.error("Switch to Base first.");
      return;
    }
    if (insufficientFunds) {
      notification.error(`Not enough ${paymentMode} for the query.`);
      return;
    }
    setPipeline({ status: "submitting" });
    try {
      let txHash: `0x${string}` | undefined;
      if (paymentMode === "ETH") {
        // 1% slippage buffer; contract refunds the excess
        const value = (requiredEth * 101n) / 100n;
        txHash = (await writeQuery({
          functionName: "queryETH",
          args: [mode],
          value,
        })) as `0x${string}` | undefined;
      } else {
        txHash = (await writeQuery({
          functionName: "queryCLAWD",
          args: [mode, requiredClawd],
        })) as `0x${string}` | undefined;
      }
      setTimeout(openMobileWallet, 2_000);
      if (!txHash) {
        setPipeline({ status: "input" });
        return;
      }
      setPipeline({ status: "loading", txHash, mode, wallet: connectedAddress as `0x${string}` });
      refetchClawdBalance();
      refetchClawdAllowance();
    } catch (err) {
      const parsed = getParsedErrorWithAllAbis(err, base.id);
      notification.error(parsed);
      setPipeline({ status: "input" });
    }
  }, [
    connectedAddress,
    insufficientFunds,
    mode,
    onWrongNetwork,
    paymentMode,
    refetchClawdAllowance,
    refetchClawdBalance,
    requiredClawd,
    requiredEth,
    writeQuery,
  ]);

  const reset = useCallback(() => {
    setPipeline({ status: "input" });
    setLoadingTextIndex(0);
  }, []);

  // ------- Display values -------
  const formattedEthRequired = requiredEth > 0n ? Number(formatEther(requiredEth)).toFixed(6) : "—";
  const formattedClawdRequired =
    requiredClawd > 0n ? Number(formatUnits(requiredClawd, clawdDecimals)).toLocaleString() : "—";
  const formattedEthBalance = Number(formatEther(ethBalance)).toFixed(4);
  const formattedClawdBalance = Number(formatUnits(clawdBalance, clawdDecimals)).toLocaleString();
  const approveSecondsLeft = Math.max(0, Math.ceil((approveCooldownUntil - now) / 1000));

  return (
    <div className="flex flex-col items-center grow w-full px-4 pt-10 pb-24">
      <div className="w-full max-w-2xl">
        <header className="mb-10 text-center">
          <div className="text-6xl mb-4">🪞</div>
          <h1 className="text-5xl font-bold tracking-tight mb-3">CLAWD Mirror</h1>
          <p className="text-lg opacity-80 max-w-xl mx-auto">
            Pay <span className="font-semibold">$0.05</span> in ETH or CLAWD on Base. Get a shareable wallet personality
            profile — pick your focus and tone.
          </p>
        </header>

        <section className="card bg-base-100 border border-base-300 shadow-center p-6 sm:p-8">
          {pipeline.status === "input" || pipeline.status === "submitting" ? (
            <InputPanel
              focus={focus}
              setFocus={setFocus}
              tone={tone}
              setTone={setTone}
              paymentMode={paymentMode}
              setPaymentMode={setPaymentMode}
              isConnected={isConnected}
              onWrongNetwork={Boolean(onWrongNetwork)}
              onSwitchChain={() => switchChain({ chainId: base.id })}
              isSwitchingChain={isSwitchingChain}
              ethRequiredFormatted={formattedEthRequired}
              clawdRequiredFormatted={formattedClawdRequired}
              ethBalanceFormatted={formattedEthBalance}
              clawdBalanceFormatted={formattedClawdBalance}
              insufficientFunds={insufficientFunds}
              needsApproval={needsApproval}
              onApprove={handleApprove}
              approveSubmitting={approveSubmitting}
              inApproveCooldown={inApproveCooldown}
              approveSecondsLeft={approveSecondsLeft}
              onSubmit={handleSubmit}
              submitting={pipeline.status === "submitting" || isMining}
            />
          ) : null}

          {pipeline.status === "loading" ? (
            <LoadingPanel
              loadingText={LOADING_STATES_BY_MODE[pipeline.mode][loadingTextIndex]}
              txHash={pipeline.txHash}
            />
          ) : null}

          {pipeline.status === "result" ? <ResultPanel result={pipeline.result} onReset={reset} /> : null}

          {pipeline.status === "error" ? <ErrorPanel message={pipeline.message} onReset={reset} /> : null}
        </section>

        <div className="mt-6 text-center text-xs opacity-60">
          Payments routed through <Address address={MIRROR_PAYMENT_ADDRESS} disableAddressLink={false} /> on Base.
        </div>
      </div>
    </div>
  );
};

export default Home;

// =============================================================================
// Sub-panels
// =============================================================================

type InputPanelProps = {
  focus: Focus;
  setFocus: (f: Focus) => void;
  tone: Tone;
  setTone: (t: Tone) => void;
  paymentMode: PaymentMode;
  setPaymentMode: (p: PaymentMode) => void;
  isConnected: boolean;
  onWrongNetwork: boolean;
  onSwitchChain: () => void;
  isSwitchingChain: boolean;
  ethRequiredFormatted: string;
  clawdRequiredFormatted: string;
  ethBalanceFormatted: string;
  clawdBalanceFormatted: string;
  insufficientFunds: boolean;
  needsApproval: boolean;
  onApprove: () => void;
  approveSubmitting: boolean;
  inApproveCooldown: boolean;
  approveSecondsLeft: number;
  onSubmit: () => void;
  submitting: boolean;
};

const InputPanel = (props: InputPanelProps) => {
  const {
    focus,
    setFocus,
    tone,
    setTone,
    paymentMode,
    setPaymentMode,
    isConnected,
    onWrongNetwork,
    onSwitchChain,
    isSwitchingChain,
    ethRequiredFormatted,
    clawdRequiredFormatted,
    ethBalanceFormatted,
    clawdBalanceFormatted,
    insufficientFunds,
    needsApproval,
    onApprove,
    approveSubmitting,
    inApproveCooldown,
    approveSecondsLeft,
    onSubmit,
    submitting,
  } = props;

  const approveButtonDisabled = approveSubmitting || inApproveCooldown;
  const submitDisabled = !isConnected || onWrongNetwork || submitting || (paymentMode === "CLAWD" && needsApproval);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="text-sm font-semibold opacity-70 mb-2">Focus</div>
        <div className="join w-full">
          <button
            type="button"
            className={`btn join-item flex-1 ${focus === "CLAWD" ? "btn-primary" : "btn-ghost border border-base-300"}`}
            onClick={() => setFocus("CLAWD")}
          >
            CLAWD
          </button>
          <button
            type="button"
            className={`btn join-item flex-1 ${focus === "General" ? "btn-primary" : "btn-ghost border border-base-300"}`}
            onClick={() => setFocus("General")}
          >
            General
          </button>
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold opacity-70 mb-2">Tone</div>
        <div className="join w-full">
          <button
            type="button"
            className={`btn join-item flex-1 ${tone === "Read" ? "btn-primary" : "btn-ghost border border-base-300"}`}
            onClick={() => setTone("Read")}
          >
            Read Me
          </button>
          <button
            type="button"
            className={`btn join-item flex-1 ${tone === "Roast" ? "btn-primary" : "btn-ghost border border-base-300"}`}
            onClick={() => setTone("Roast")}
          >
            Roast Me
          </button>
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold opacity-70 mb-2">Pay With</div>
        <div className="join w-full">
          <button
            type="button"
            className={`btn join-item flex-1 ${paymentMode === "ETH" ? "btn-secondary" : "btn-ghost border border-base-300"}`}
            onClick={() => setPaymentMode("ETH")}
          >
            ETH
          </button>
          <button
            type="button"
            className={`btn join-item flex-1 ${paymentMode === "CLAWD" ? "btn-secondary" : "btn-ghost border border-base-300"}`}
            onClick={() => setPaymentMode("CLAWD")}
          >
            CLAWD
          </button>
        </div>
      </div>

      <div className="rounded-lg bg-base-200 p-4 text-sm flex flex-col gap-2">
        <div className="flex justify-between">
          <span className="opacity-70">Price</span>
          <span className="font-mono">
            {paymentMode === "ETH" ? `~${ethRequiredFormatted} ETH (~$0.05)` : `${clawdRequiredFormatted} CLAWD`}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="opacity-70">Your balance</span>
          <span className="font-mono">
            {paymentMode === "ETH" ? `${ethBalanceFormatted} ETH` : `${clawdBalanceFormatted} CLAWD`}
          </span>
        </div>
        {paymentMode === "ETH" ? (
          <div className="text-xs opacity-50 mt-1">
            Live ETH price from Chainlink. Overpayment is refunded automatically.
          </div>
        ) : (
          <div className="text-xs opacity-50 mt-1">
            CLAWD price set by contract owner. Community token — USD value varies.
          </div>
        )}
      </div>

      {!isConnected ? (
        <div className="text-center text-sm opacity-70">Connect your wallet (top right) to begin.</div>
      ) : onWrongNetwork ? (
        <button type="button" className="btn btn-warning" onClick={onSwitchChain} disabled={isSwitchingChain}>
          {isSwitchingChain ? "Switching..." : "Switch to Base"}
        </button>
      ) : paymentMode === "CLAWD" && needsApproval ? (
        <button type="button" className="btn btn-accent" onClick={onApprove} disabled={approveButtonDisabled}>
          {approveSubmitting
            ? "Approving..."
            : inApproveCooldown
              ? `Approved (${approveSecondsLeft}s)`
              : "Approve CLAWD"}
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-lg" onClick={onSubmit} disabled={submitDisabled}>
          {submitting ? "Submitting..." : "Generate My Profile"}
        </button>
      )}

      {insufficientFunds && isConnected && !onWrongNetwork ? (
        <div className="text-center text-error text-sm">Not enough {paymentMode} to cover the price.</div>
      ) : null}
    </div>
  );
};

const LoadingPanel = ({ loadingText, txHash }: { loadingText: string; txHash: `0x${string}` }) => {
  return (
    <div className="flex flex-col items-center gap-6 py-8">
      <div className="loading loading-ring loading-lg text-primary"></div>
      <div className="text-lg font-medium text-center min-h-[1.5em]">{loadingText}</div>
      <div className="text-xs opacity-60">
        Payment confirmed.{" "}
        <a className="link" href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer">
          View tx
        </a>
      </div>
      <div className="text-xs opacity-50 text-center max-w-md">
        This usually takes 10–30 seconds. Don&apos;t close the tab — your profile will appear automatically.
      </div>
    </div>
  );
};

const ResultPanel = ({ result, onReset }: { result: ProfileResult; onReset: () => void }) => {
  const cachedHoursAgo = result.cached
    ? Math.max(1, Math.floor((Date.now() - result.generatedAt) / (60 * 60 * 1000)))
    : 0;

  return (
    <div className="flex flex-col gap-6">
      {result.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={result.imageUrl}
          alt={result.headline}
          className="w-full rounded-lg border border-base-300 shadow-sm"
        />
      ) : null}

      <div className="flex flex-wrap gap-2 items-center">
        {result.cached ? <span className="badge badge-ghost">Cached {cachedHoursAgo}h ago</span> : null}
        <span className="badge badge-outline">{result.isClawdPayment ? "Paid in CLAWD" : "Paid in ETH"}</span>
      </div>

      {result.lowConfidence ? (
        <div className="alert alert-warning text-sm">
          Limited CLAWD ecosystem activity detected — try General mode for a richer profile.
        </div>
      ) : null}

      <div>
        <h2 className="text-2xl font-bold mb-2">{result.headline}</h2>
        <p className="text-base opacity-80 italic">{result.tldr}</p>
      </div>

      {result.signals?.length ? (
        <ul className="grid sm:grid-cols-2 gap-2">
          {result.signals.map((s, i) => (
            <li key={i} className="bg-base-200 border border-base-300 rounded-md px-3 py-2 text-sm">
              {s}
            </li>
          ))}
        </ul>
      ) : null}

      <div
        className="prose max-w-none text-base"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(result.fullText || "") }}
      />

      <div className="flex flex-wrap gap-3">
        {result.imageUrl ? (
          <a className="btn btn-secondary" href={result.imageUrl} download={`clawd-mirror-${result.wallet}.png`}>
            Download card
          </a>
        ) : null}
        <button type="button" className="btn btn-outline" onClick={onReset}>
          Generate again
        </button>
      </div>
    </div>
  );
};

const ErrorPanel = ({ message, onReset }: { message: string; onReset: () => void }) => {
  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <div className="text-4xl">⚠️</div>
      <p className="text-center max-w-md">{message}</p>
      <button type="button" className="btn btn-outline" onClick={onReset}>
        Try again
      </button>
    </div>
  );
};
