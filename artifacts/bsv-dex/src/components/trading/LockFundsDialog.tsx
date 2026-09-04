/**
 * LockFundsDialog — two-stage modal for on-chain escrow lock.
 *
 *   Stage 1 (confirm): shows order details + amount + chain + escrow address,
 *                      with a big "Confirm & Lock" button. Nothing happens
 *                      until the user clicks it.
 *   Stage 2 (status):  shows live progress (waiting for wallet → submitting →
 *                      confirmed), tx hash + explorer link, and a Close button.
 */

import { useEffect, useMemo, useState } from "react";
import { Link2, Loader2, CheckCircle2, AlertCircle, Wallet, Shield } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  resolveEscrowAsset,
  escrowAddress,
  chainLabel,
  type EscrowTxResult,
} from "@/lib/escrow";

type EscrowStatus = "idle" | "approving" | "locking" | "cancelling" | "success" | "error";

interface Order {
  orderId:  string;
  side:     "buy" | "sell";
  base:     string;
  quote:    string;
  quantity: number;
  price:    number;
}

interface Props {
  open:        boolean;
  onOpenChange: (open: boolean) => void;
  order:       Order | null;
  chainId:     number | null;
  status:      EscrowStatus;
  errorMsg:    string | null;
  txResult:    EscrowTxResult | null;
  onConfirm:   () => Promise<EscrowTxResult | null>;
}

function shortenAddr(a: string | null): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function explorerBase(chainId: number | null): string {
  const map: Record<number, string> = {
    1:        "https://etherscan.io",
    10:       "https://optimistic.etherscan.io",
    56:       "https://bscscan.com",
    130:      "https://uniscan.xyz",
    137:      "https://polygonscan.com",
    324:      "https://explorer.zksync.io",
    1329:     "https://seitrace.com",
    8453:     "https://basescan.org",
    42161:    "https://arbiscan.io",
    43114:    "https://snowtrace.io",
    59144:    "https://lineascan.build",
    534352:   "https://scrollscan.com",
    11155111: "https://sepolia.etherscan.io",
    84532:    "https://sepolia.basescan.org",
  };
  return (chainId ? map[chainId] : undefined) ?? "https://etherscan.io";
}

function formatAmount(rawAmount: bigint, decimals: number): string {
  if (rawAmount === 0n) return "0";
  const s = rawAmount.toString().padStart(decimals + 1, "0");
  const intPart  = s.slice(0, -decimals) || "0";
  const fracPart = s.slice(-decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart.slice(0, 8)}` : intPart;
}

export function LockFundsDialog({
  open, onOpenChange, order, chainId, status, errorMsg, txResult, onConfirm,
}: Props) {
  // Stage flips to "status" once the user clicks Confirm; stays at "confirm"
  // before that. Reset whenever the dialog re-opens with a fresh order.
  const [stage, setStage] = useState<"confirm" | "status">("confirm");
  useEffect(() => {
    if (open) setStage("confirm");
  }, [open, order?.orderId]);

  const asset = useMemo(() => {
    if (!order || !chainId) return null;
    return resolveEscrowAsset(
      chainId, order.side, order.base, order.quote, order.quantity, order.price,
    );
  }, [order, chainId]);

  const escrowAddr = chainId ? escrowAddress(chainId) : null;
  const chainName  = chainLabel(chainId);
  const isLoading  = status === "approving" || status === "locking";
  const isSuccess  = status === "success" && !!txResult;
  const isError    = status === "error";

  // Auto-flip from "confirm" to "status" once any tx activity starts.
  useEffect(() => {
    if (stage === "confirm" && (isLoading || isSuccess || isError)) setStage("status");
  }, [stage, isLoading, isSuccess, isError]);

  const handleConfirm = async () => {
    setStage("status");
    await onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => {
      // Don't allow closing mid-tx — user must wait.
      if (!o && isLoading) return;
      onOpenChange(o);
    }}>
      <DialogContent className="max-w-sm border-violet-500/20 bg-zinc-950 text-zinc-50">
        {stage === "confirm" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-violet-300">
                <Shield size={18} /> Lock funds on-chain
              </DialogTitle>
              <DialogDescription className="text-zinc-400 text-xs leading-relaxed pt-1">
                Locks your {asset?.symbol ?? "asset"} in the OrahDEX escrow
                contract on {chainName}. The funds stay yours — you can cancel
                the order at any time and they'll be refunded automatically.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs">
              <Row label="Amount">
                <span className="font-mono text-base font-bold text-violet-300">
                  {asset ? formatAmount(asset.rawAmount, asset.decimals) : "—"}{" "}
                  <span className="text-sm text-zinc-400">{asset?.symbol ?? ""}</span>
                </span>
              </Row>
              <Row label="Network">
                <span className="font-medium">{chainName}</span>
              </Row>
              <Row label="Escrow contract">
                <a
                  href={escrowAddr ? `${explorerBase(chainId)}/address/${escrowAddr}` : "#"}
                  target="_blank" rel="noopener noreferrer"
                  className="font-mono text-violet-300 hover:underline"
                >
                  {shortenAddr(escrowAddr)}
                </a>
              </Row>
              <Row label="Order ID">
                <span className="font-mono text-zinc-400">
                  {order ? `${order.orderId.slice(0, 8)}…` : "—"}
                </span>
              </Row>
            </div>

            {!asset && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-300">
                Lock amount couldn't be determined — the price feed may still be loading. Close this dialog and try again in a moment.
              </div>
            )}

            <div className="flex flex-col gap-2 pt-1">
              <button
                onClick={handleConfirm}
                disabled={!asset || !escrowAddr}
                className={cn(
                  "w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-bold text-white",
                  "transition-all hover:bg-violet-500 active:opacity-80",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  "flex items-center justify-center gap-2",
                )}
              >
                <Wallet size={14} /> Confirm &amp; Lock
              </button>
              <button
                onClick={() => onOpenChange(false)}
                className="w-full rounded-lg border border-zinc-800 px-4 py-2 text-xs text-zinc-400 hover:bg-zinc-900"
              >
                Cancel
              </button>
            </div>

            <p className="text-[10px] leading-relaxed text-zinc-500">
              Your wallet will ask you to sign a transaction. Network gas fee
              applies. We never take custody of your funds.
            </p>
          </>
        ) : (
          // ── Stage 2: live status ─────────────────────────────────────────
          <>
            <DialogHeader>
              <DialogTitle className={cn(
                "flex items-center gap-2",
                isSuccess && "text-emerald-300",
                isError   && "text-red-300",
                !isSuccess && !isError && "text-violet-300",
              )}>
                {isSuccess ? <CheckCircle2 size={18} /> : isError ? <AlertCircle size={18} /> : <Loader2 size={18} className="animate-spin" />}
                {isSuccess ? "Funds locked!" : isError ? "Lock failed" : statusLabel(status)}
              </DialogTitle>
              <DialogDescription className="text-zinc-400 text-xs leading-relaxed pt-1">
                {isSuccess
                  ? `${asset ? formatAmount(asset.rawAmount, asset.decimals) : ""} ${asset?.symbol ?? ""} are now locked in the escrow contract on ${chainName}.`
                  : isError
                  ? "The transaction did not go through. Your funds were not moved."
                  : "Approve the transaction in your wallet. Don't close this window."}
              </DialogDescription>
            </DialogHeader>

            {isSuccess && txResult && (
              <a
                href={txResult.explorerUrl}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
              >
                <Link2 size={12} /> View on explorer
                <span className="font-mono text-[10px] opacity-70">
                  {txResult.txHash.slice(0, 10)}…
                </span>
              </a>
            )}

            {isError && errorMsg && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[11px] text-red-300">
                {errorMsg}
              </div>
            )}

            {!isLoading && (
              <button
                onClick={() => onOpenChange(false)}
                className={cn(
                  "w-full rounded-lg px-4 py-2 text-sm font-bold transition-all",
                  isSuccess
                    ? "bg-emerald-600 text-white hover:bg-emerald-500"
                    : "border border-zinc-800 text-zinc-300 hover:bg-zinc-900",
                )}
              >
                {isSuccess ? "Done" : "Close"}
              </button>
            )}

            {isError && (
              <button
                onClick={handleConfirm}
                className="w-full rounded-lg bg-violet-600 px-4 py-2 text-sm font-bold text-white hover:bg-violet-500"
              >
                Try again
              </button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function statusLabel(s: EscrowStatus): string {
  switch (s) {
    case "approving":  return "Approving token…";
    case "locking":    return "Waiting for confirmation…";
    case "cancelling": return "Cancelling on-chain…";
    default:           return "Working…";
  }
}
