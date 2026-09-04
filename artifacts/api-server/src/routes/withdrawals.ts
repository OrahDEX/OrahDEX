import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { withdrawalRequestsTable, platformSettingsTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import crypto from "node:crypto";
import { requireAdminToken, isValidAdminToken } from "../middleware/adminAuth.js";
import { processWithdrawal, EVM_USE_TESTNET } from "../lib/withdrawalProcessor.js";
import { getEvmHotWalletAddress } from "../lib/exchangeHotWallet.js";
import { getOrCreateWallet, fetchWalletBalance } from "../lib/bsvWallet.js";
import { createPublicClient, http } from "viem";
import {
  issueWithdrawChallenge,
  verifyWithdrawSignature,
  issueBsvWithdrawChallenge,
  verifyBsvWithdrawSignature,
  issueSolWithdrawChallenge,
  verifySolWithdrawSignature,
} from "../lib/walletAuth.js";

const router: IRouter = Router();

// ── Per-wallet withdrawal rate limiter (5 requests / 60 s) ───────────────────
const _withdrawRateMap = new Map<string, { count: number; resetAt: number }>();
const WITHDRAW_RATE_WINDOW_MS = 60_000;
const WITHDRAW_RATE_LIMIT = 5;

function checkWithdrawRateLimit(req: import("express").Request, res: import("express").Response, key: string): boolean {
  const now = Date.now();
  const rec = _withdrawRateMap.get(key) ?? { count: 0, resetAt: now + WITHDRAW_RATE_WINDOW_MS };
  if (now > rec.resetAt) {
    _withdrawRateMap.set(key, { count: 1, resetAt: now + WITHDRAW_RATE_WINDOW_MS });
    return true;
  }
  rec.count++;
  _withdrawRateMap.set(key, rec);
  if (rec.count > WITHDRAW_RATE_LIMIT) {
    res.status(429).json({ error: "Too many withdrawal requests. Please wait 60 seconds before trying again." });
    return false;
  }
  return true;
}

// ── POST /withdraw/challenge ───────────────────────────────────────────────────
// Returns a server-issued nonce that the wallet must sign before calling
// POST /withdrawals. The signed challenge proves the caller owns the wallet.
// Supports EVM (0x…), BSV (1…/3…), and Solana (base58) addresses.
router.post("/withdraw/challenge", (req, res) => {
  const { walletAddress, bsvAddress } = req.body as { walletAddress?: string; bsvAddress?: string };
  if (!walletAddress) {
    res.status(400).json({ error: "walletAddress is required" });
    return;
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    // Passkey wallets doing a BSV withdrawal supply bsvAddress so the challenge is
    // keyed on the BSV address (verified via Bitcoin message signature) while the
    // internal DEX balance remains tracked under the EVM address.
    if (bsvAddress && /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(bsvAddress)) {
      res.json(issueBsvWithdrawChallenge(bsvAddress));
    } else {
      res.json(issueWithdrawChallenge(walletAddress));
    }
  } else if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(walletAddress)) {
    res.json(issueBsvWithdrawChallenge(walletAddress));
  } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    res.json(issueSolWithdrawChallenge(walletAddress));
  } else {
    res.status(400).json({ error: "Unsupported wallet address format. Supported: EVM (0x…), BSV (1…/3…), Solana (base58)." });
  }
});

// ── POST /withdrawals ─────────────────────────────────────────────────────────
// Creates a withdrawal request AND immediately deducts the amount from the
// user's available internal balance. If the balance is insufficient the
// request is rejected so the user cannot over-withdraw.
// EVM wallet callers (0x…) must supply a `signature` obtained via
// POST /withdraw/challenge to prove ownership of `walletAddress`.
// ── Recipient address validation ──────────────────────────────────────────────
// Networks that use standard EVM (0x-prefixed 20-byte) addresses.
const EVM_NETWORKS = new Set([
  "ETH", "BNB", "MATIC", "AVAX", "FTM", "BASE", "ARB", "OP", "ZKSYNC", "LINEA",
  "SCROLL", "BLAST", "MODE", "TAIKO", "SEPOLIA", "BASE_SEP", "ARB_SEP", "EVM",
]);
// BSV P2PKH (1…) or P2SH (3…) address, base58 chars, 26-35 chars.
const BSV_ADDRESS_RE = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;

router.post("/withdrawals", async (req, res) => {
  // Normalise to lowercase so DB lookups match regardless of EVM checksum casing
  const walletAddress: string | undefined = req.body.walletAddress
    ? String(req.body.walletAddress).toLowerCase()
    : req.body.walletAddress;
  const { asset, amount, network, networkLabel, recipient, fee, signature, bsvSignerAddress } = req.body;
  if (walletAddress && !checkWithdrawRateLimit(req, res, walletAddress)) return;

  if (!walletAddress || !asset || !amount || !network || !recipient) {
    res.status(400).json({ error: "Missing required fields: walletAddress, asset, amount, network, recipient" });
    return;
  }

  // Validate recipient address format based on network type.
  // This prevents misdirected withdrawals to malformed or wrong-network addresses.
  const networkUp = String(network).toUpperCase();
  const isEvmNetwork = EVM_NETWORKS.has(networkUp);
  const isBsvNetwork = networkUp === "BSV";
  if (isEvmNetwork && !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    res.status(400).json({
      error: `Invalid recipient address for ${network} network. Expected 0x-prefixed 20-byte EVM address (0x + 40 hex chars).`,
    });
    return;
  }
  if (isBsvNetwork && !BSV_ADDRESS_RE.test(recipient)) {
    res.status(400).json({
      error: "Invalid recipient address for BSV network. Expected a P2PKH (1…) or P2SH (3…) address.",
    });
    return;
  }

  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    res.status(400).json({ error: "Amount must be a positive number" });
    return;
  }

  const parsedFee = fee != null ? parseFloat(fee) : 0;
  if (isNaN(parsedFee) || parsedFee < 0 || parsedFee >= parsed) {
    res.status(400).json({ error: "Invalid fee: must be a non-negative number less than the withdrawal amount" });
    return;
  }

  // Require wallet ownership proof for all external wallet types.
  if (walletAddress.startsWith("0x")) {
    // EVM wallet.
    // Passkey wallets withdrawing BSV supply a bsvSignerAddress — the Bitcoin P2PKH
    // address of the passkey-derived BSV key. The challenge was issued to that address
    // and must be verified with a Bitcoin message signature, while the DEX internal
    // balance remains tracked under the EVM address.
    if (!signature) {
      res.status(401).json({
        error: "signature is required for EVM wallet withdrawals. " +
               "Request a challenge via POST /withdraw/challenge, sign it with your wallet, " +
               "and include the signature in this request.",
      });
      return;
    }
    const isBsvWithdrawal =
      isBsvNetwork &&
      typeof bsvSignerAddress === "string" &&
      /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(bsvSignerAddress);
    if (isBsvWithdrawal) {
      try {
        verifyBsvWithdrawSignature(bsvSignerAddress, signature);
      } catch (authErr: any) {
        res.status(401).json({ error: authErr.message });
        return;
      }
    } else {
      try {
        verifyWithdrawSignature(walletAddress, signature);
      } catch (authErr: any) {
        res.status(401).json({ error: authErr.message });
        return;
      }
    }
  } else if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(walletAddress)) {
    // BSV P2PKH / P2SH wallet
    if (!signature) {
      res.status(401).json({
        error: "signature is required for BSV wallet withdrawals. " +
               "Request a challenge via POST /withdraw/challenge, sign it with your BSV wallet, " +
               "and include the base64 signature in this request.",
      });
      return;
    }
    try {
      verifyBsvWithdrawSignature(walletAddress, signature);
    } catch (authErr: any) {
      res.status(401).json({ error: authErr.message });
      return;
    }
  } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    // Solana base58 public key
    if (!signature) {
      res.status(401).json({
        error: "signature is required for Solana wallet withdrawals. " +
               "Request a challenge via POST /withdraw/challenge, sign it with your Solana wallet, " +
               "and include the signature in this request.",
      });
      return;
    }
    try {
      verifySolWithdrawSignature(walletAddress, signature);
    } catch (authErr: any) {
      res.status(401).json({ error: authErr.message });
      return;
    }
  } else {
    res.status(400).json({
      error: "Unsupported wallet address format. Supported: EVM (0x…), BSV (1…/3…), Solana (base58).",
    });
    return;
  }

  const id = crypto.randomUUID();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check current available balance (lock the row for the transaction)
    const { rows: balRows } = await client.query<{ available: string; seeded: string }>(
      `SELECT available, seeded FROM user_balances
       WHERE wallet_address = $1 AND asset_symbol = $2
       FOR UPDATE`,
      [walletAddress, asset],
    );

    const available = parseFloat(balRows[0]?.available ?? "0");
    // `seeded` is platform-owned liquidity — users may trade with it but cannot withdraw it.
    // Only admin withdrawals bypass this check.
    const seeded      = parseFloat(balRows[0]?.seeded ?? "0");
    const withdrawable = Math.max(0, available - seeded);

    // Allow up to 1 satoshi (1e-8) of floating-point rounding slack so that
    // a MAX withdrawal whose .toFixed(8) rounds up by a sub-satoshi amount
    // isn't incorrectly rejected.
    const EPSILON = 1e-8;
    if (withdrawable + EPSILON < parsed) {
      await client.query("ROLLBACK");
      const realBalance = withdrawable.toFixed(8);
      res.status(400).json({
        error: withdrawable <= 0
          ? `Your ${asset} balance is platform liquidity and cannot be withdrawn. Deposit real ${asset} to withdraw.`
          : `Insufficient withdrawable balance. You can withdraw up to ${realBalance} ${asset} (your deposited/earned balance).`,
      });
      return;
    }

    // Clamp to actual available so we never debit more than the ledger holds
    const effectiveParsed = Math.min(parsed, available);

    // Deduct from available immediately so the balance reflects the pending withdrawal
    await client.query(
      `UPDATE user_balances
       SET available = available - $1, updated_at = now()
       WHERE wallet_address = $2 AND asset_symbol = $3`,
      [effectiveParsed.toString(), walletAddress, asset],
    );

    // Record the withdrawal request (using same client so it's in the same transaction)
    await client.query(
      `INSERT INTO withdrawal_requests
         (id, wallet_address, asset, amount, network, network_label, recipient, fee, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', now())`,
      [id, walletAddress, asset, effectiveParsed.toString(), network, networkLabel ?? network, recipient, fee ?? null],
    );

    await client.query("COMMIT");

    req.log.info({ id, walletAddress, asset, amount: effectiveParsed, network, recipient }, "withdrawals: request created and balance deducted");

    // ── Attempt immediate on-chain processing ─────────────────────────────────
    // Run async so the HTTP response is fast. Errors are caught internally and
    // leave the request in "pending" for admin fallback.
    setImmediate(async () => {
      try {
        const result = await processWithdrawal({ asset, amount: effectiveParsed, network, recipient });

        if (result.status === "completed" && result.txid) {
          await pool.query(
            `UPDATE withdrawal_requests
             SET status = 'completed', txid = $1, note = $2, processed_at = now(),
                 arc_txid = $3, arc_status = $4
             WHERE id = $5`,
            [result.txid, result.explorer ?? null, result.arcTxid ?? null, result.arcStatus ?? null, id],
          );
          req.log.info({ id, txid: result.txid, arcStatus: result.arcStatus }, "withdrawals: auto-processed on-chain");
        } else if (result.note) {
          await pool.query(
            `UPDATE withdrawal_requests SET note = $1 WHERE id = $2`,
            [result.note, id],
          );
        }
      } catch (autoErr: any) {
        // Auto-processing threw — refund the user's available balance and mark
        // the request as failed in a single transaction so it cannot be retried
        // by an admin without first being reset. Without this, the user's
        // funds were debited but no on-chain send happened, leaving them stuck.
        const refundClient = await pool.connect();
        try {
          await refundClient.query("BEGIN");
          // Only refund + fail if still pending — guards against a race where
          // a parallel retry already advanced the row to processing/completed.
          const { rows: stillPending } = await refundClient.query(
            `SELECT 1 FROM withdrawal_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`,
            [id],
          );
          if (stillPending.length > 0) {
            await refundClient.query(
              `UPDATE user_balances
               SET available = available + $1, updated_at = now()
               WHERE wallet_address = $2 AND asset_symbol = $3`,
              [parsed.toString(), walletAddress, asset],
            );
            await refundClient.query(
              `UPDATE withdrawal_requests
               SET status = 'failed',
                   note   = $1,
                   processed_at = now()
               WHERE id = $2`,
              [`Auto-process failed: ${(autoErr?.message ?? "unknown").slice(0, 200)}`, id],
            );
            req.log.warn({ autoErr, id }, "withdrawals: auto-process failed — balance refunded, request marked failed");
          }
          await refundClient.query("COMMIT");
        } catch (refundErr) {
          await refundClient.query("ROLLBACK").catch(() => {});
          // Last resort: log loudly so operators can intervene. This is the
          // only path where funds remain debited; should be vanishingly rare.
          req.log.error({ refundErr, autoErr, id }, "withdrawals: AUTO-REFUND FAILED — manual intervention required");
        } finally {
          refundClient.release();
        }
      }
    });

    res.status(201).json({
      id,
      status: "pending",
      message: "Withdrawal submitted — processing on-chain now. Check withdrawal history for live status.",
      walletAddress,
      asset,
      amount: parsed,
      network,
      recipient,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    req.log.error({ err }, "withdrawals: failed to create request");
    res.status(500).json({ error: "Failed to record withdrawal request" });
  } finally {
    client.release();
  }
});

// Alias: POST /withdraw → same handler as POST /withdrawals
// Kept for backward compatibility with clients that call /api/withdraw (without the "s").
// Uses the Express Router's internal dispatch to re-route the request.
router.post("/withdraw", (req, res, next) => {
  req.url = "/withdrawals";
  (router as any).handle(req, res, next);
});

// ── GET /admin/withdrawals ────────────────────────────────────────────────────
router.get("/admin/withdrawals", requireAdminToken, async (req, res) => {
  try {
    // Honor ?status=pending  or  ?status=pending,cancelled,failed  to filter rows.
    // Without it we return every row (legacy behavior).
    const statusParam = (req.query.status as string | undefined)?.trim();
    const allowed = ["pending", "processing", "completed", "cancelled", "failed"];
    const statuses = statusParam
      ? statusParam.split(",").map(s => s.trim().toLowerCase()).filter(s => allowed.includes(s))
      : [];

    const { rows } = statuses.length
      ? await pool.query<any>(
          `SELECT * FROM withdrawal_requests WHERE status = ANY($1) ORDER BY created_at DESC LIMIT 500`,
          [statuses],
        )
      : await pool.query<any>(
          `SELECT * FROM withdrawal_requests ORDER BY created_at DESC LIMIT 500`,
        );

    res.json(rows.map((r: any) => ({
      id:           r.id,
      walletAddress: r.wallet_address,
      asset:        r.asset,
      amount:       parseFloat(r.amount),
      network:      r.network,
      networkLabel: r.network_label,
      recipient:    r.recipient,
      fee:          r.fee,
      status:       r.status,
      txid:         r.txid,
      note:         r.note,
      arcTxid:      r.arc_txid,
      arcStatus:    r.arc_status,
      createdAt:    r.created_at,
      processedAt:  r.processed_at,
    })));
  } catch (err) {
    req.log.error({ err }, "admin/withdrawals: failed to fetch all");
    res.status(500).json({ error: "Failed to fetch withdrawal requests" });
  }
});

// ── POST /admin/withdrawals/:id/retry ─────────────────────────────────────────
// Re-attempt processing for a single withdrawal. Works for rows in 'pending',
// 'cancelled', or 'failed'. If the row was previously cancelled (and balance
// already refunded) the user balance is re-deducted before re-attempting so the
// books stay correct.
router.post("/admin/withdrawals/:id/retry", requireAdminToken, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string; wallet_address: string; asset: string; amount: string;
      network: string; recipient: string; status: string;
    }>(
      `SELECT id, wallet_address, asset, amount, network, recipient, status
         FROM withdrawal_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Withdrawal request not found" });
      return;
    }
    const wr = rows[0];
    if (wr.status === "completed") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "This withdrawal is already completed." });
      return;
    }

    // If the row was cancelled, the user's balance was refunded earlier — we
    // need to re-debit before re-trying so we don't pay them twice.
    if (wr.status === "cancelled") {
      const { rows: balRows } = await client.query<{ available: string }>(
        `SELECT available FROM user_balances
          WHERE wallet_address = $1 AND asset_symbol = $2 FOR UPDATE`,
        [wr.wallet_address, wr.asset],
      );
      const available = parseFloat(balRows[0]?.available ?? "0");
      const amount = parseFloat(wr.amount);
      if (available < amount) {
        await client.query("ROLLBACK");
        res.status(400).json({
          error: `Cannot retry: user only has ${available} ${wr.asset} available, ` +
                 `but withdrawal needs ${amount}. Refund was already credited; ` +
                 `they may have spent it.`,
        });
        return;
      }
      await client.query(
        `UPDATE user_balances SET available = available - $1, updated_at = now()
          WHERE wallet_address = $2 AND asset_symbol = $3`,
        [amount.toString(), wr.wallet_address, wr.asset],
      );
    }

    await client.query(
      `UPDATE withdrawal_requests SET status = 'processing', note = 'Manual retry by admin' WHERE id = $1`,
      [id],
    );
    await client.query("COMMIT");

    // Fire the on-chain attempt asynchronously and respond fast.
    setImmediate(async () => {
      try {
        const result = await processWithdrawal({
          asset:     wr.asset,
          amount:    parseFloat(wr.amount),
          network:   wr.network,
          recipient: wr.recipient,
        });
        if (result.status === "completed" && result.txid) {
          await pool.query(
            `UPDATE withdrawal_requests
                SET status = 'completed', txid = $1, note = $2, processed_at = now(),
                    arc_txid = $3, arc_status = $4
              WHERE id = $5`,
            [result.txid, result.explorer ?? null, result.arcTxid ?? null, result.arcStatus ?? null, id],
          );
        } else {
          await pool.query(
            `UPDATE withdrawal_requests SET status = 'pending', note = $1 WHERE id = $2`,
            [result.note ?? "Retry: still pending", id],
          );
        }
      } catch (err: any) {
        await pool.query(
          `UPDATE withdrawal_requests SET status = 'pending', note = $1 WHERE id = $2`,
          [`Retry failed: ${err?.message ?? err}`, id],
        );
      }
    });

    req.log.info({ id, prevStatus: wr.status }, "withdrawals: retry initiated");
    res.json({ id, status: "processing", message: "Retry initiated. Refresh in a few seconds." });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    req.log.error({ err: err?.message, id }, "withdrawals: retry failed");
    res.status(500).json({ error: "Retry failed. Check server logs for details." });
  } finally {
    client.release();
  }
});

// ── GET /admin/hot-wallet-status ──────────────────────────────────────────────
// Returns the system's EVM and BSV hot wallet addresses plus their current
// on-chain native balance per chain. Read-only — no keys exposed.
router.get("/admin/hot-wallet-status", requireAdminToken, async (req, res) => {
  try {
    const evmAddress = await getEvmHotWalletAddress();

    // Probe each chain's native balance in parallel. We hard-code the list here
    // because EVM_REGISTRY isn't exported; this matches the chains the app uses.
    const CHAINS = [
      { key: "ETH",     id: 1,        name: "Ethereum",         rpc: process.env.ETH_RPC_URL      ?? "https://ethereum.publicnode.com",       symbol: "ETH" },
      { key: "SEPOLIA", id: 11155111, name: "Sepolia (testnet)",rpc: process.env.SEPOLIA_RPC_URL  ?? "https://ethereum-sepolia.publicnode.com", symbol: "ETH" },
      { key: "BASE",    id: 8453,     name: "Base",             rpc: process.env.BASE_RPC_URL     ?? "https://base.publicnode.com",           symbol: "ETH" },
      { key: "ARB",     id: 42161,    name: "Arbitrum",         rpc: process.env.ARB_RPC_URL      ?? "https://arbitrum-one.publicnode.com",   symbol: "ETH" },
      { key: "OP",      id: 10,       name: "Optimism",         rpc: process.env.OP_RPC_URL       ?? "https://optimism.publicnode.com",       symbol: "ETH" },
      { key: "BNB",     id: 56,       name: "BNB Chain",        rpc: process.env.BSC_RPC_URL      ?? "https://bsc.publicnode.com",            symbol: "BNB" },
      { key: "MATIC",   id: 137,      name: "Polygon",          rpc: process.env.POLYGON_RPC_URL  ?? "https://polygon.publicnode.com",        symbol: "MATIC" },
    ];

    const evmBalances = await Promise.all(CHAINS.map(async c => {
      try {
        const client = createPublicClient({ transport: http(c.rpc) });
        const wei    = await client.getBalance({ address: evmAddress as `0x${string}` });
        return { ...c, balance: Number(wei) / 1e18, error: null as string | null };
      } catch (err: any) {
        return { ...c, balance: 0, error: err?.message ?? "RPC error" };
      }
    }));

    // BSV hot wallet
    let bsvAddress = "", bsvBalance = 0, bsvError: string | null = null;
    try {
      const w   = await getOrCreateWallet();
      const bal = await fetchWalletBalance(w.address);
      bsvAddress = w.address;
      bsvBalance = bal.totalSatoshis / 1e8;
    } catch (err: any) {
      bsvError = err?.message ?? "BSV RPC error";
    }

    res.json({
      evmAddress,
      testnetMode: EVM_USE_TESTNET,
      chains: evmBalances,
      bsv: { address: bsvAddress, balance: bsvBalance, error: bsvError },
    });
  } catch (err: any) {
    req.log.error({ err: err?.message }, "admin/hot-wallet-status: failed");
    res.status(500).json({ error: "Failed to fetch hot wallet status" });
  }
});

// ── PATCH /withdrawals/:id  (alias: /admin/withdrawals/:id/status) ───────────
// Admin action: update status to 'cancelled' (refunds balance), 'processing',
// or 'completed' (with optional txid). The /admin/.../status alias is what the
// admin LedgerManager UI calls — keep both in sync.
router.patch(["/withdrawals/:id", "/admin/withdrawals/:id/status"], requireAdminToken, async (req, res) => {
  const { id } = req.params;
  const { status, txid, note } = req.body as { status: string; txid?: string; note?: string };

  const VALID = ["cancelled", "processing", "completed"];
  if (!VALID.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${VALID.join(", ")}` });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fetch the current withdrawal request (lock for update)
    const { rows } = await client.query<{
      id: string; wallet_address: string; asset: string; amount: string; status: string;
    }>(
      `SELECT id, wallet_address, asset, amount, status
       FROM withdrawal_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Withdrawal request not found" });
      return;
    }

    const wr = rows[0];

    if (wr.status === status) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Request is already ${status}` });
      return;
    }

    if (wr.status === "completed" || wr.status === "cancelled") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Cannot change a ${wr.status} request` });
      return;
    }

    // If cancelling — refund the deducted balance back to the user
    if (status === "cancelled") {
      await client.query(
        `INSERT INTO user_balances (wallet_address, asset_symbol, available, updated_at)
         VALUES ($1::varchar, $2::varchar, $3::numeric, now())
         ON CONFLICT (wallet_address, asset_symbol)
         DO UPDATE SET available = user_balances.available + EXCLUDED.available,
                       updated_at = now()`,
        [wr.wallet_address, wr.asset, wr.amount],
      );
    }

    await client.query(
      `UPDATE withdrawal_requests
       SET status = $1::varchar,
           txid = COALESCE($2::varchar, txid),
           note = COALESCE($3::text, note),
           processed_at = CASE WHEN $1::varchar IN ('completed','cancelled') THEN now() ELSE processed_at END
       WHERE id = $4::varchar`,
      [status, txid ?? null, note ?? null, id],
    );

    await client.query("COMMIT");

    req.log.info({ id, status, walletAddress: wr.wallet_address, asset: wr.asset }, "withdrawals: status updated");

    // ── Sync status back to bot_withdrawal_history if this was a platform bot withdrawal ──
    if (wr.wallet_address === "platform_bot" && (status === "completed" || status === "cancelled")) {
      try {
        const historyRows = await db.select()
          .from(platformSettingsTable)
          .where(eq(platformSettingsTable.key, "bot_withdrawal_history"));
        const history: any[] = historyRows[0]?.value ? JSON.parse(historyRows[0].value) : [];
        const idx = history.findIndex((h: any) => h.id === id);
        if (idx !== -1) {
          history[idx].status = status === "completed" ? "completed" : "cancelled";
          if (txid && status === "completed") history[idx].txid = txid;
          await db.insert(platformSettingsTable)
            .values({ key: "bot_withdrawal_history", value: JSON.stringify(history) })
            .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value: JSON.stringify(history), updatedAt: new Date() } });
        }
      } catch (syncErr) {
        req.log.warn({ syncErr }, "withdrawals: failed to sync status to bot_withdrawal_history (non-fatal)");
      }
    }

    res.json({ id, status, txid: txid ?? null, message: `Withdrawal ${status}` });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    req.log.error({ err }, "withdrawals: failed to update status");
    res.status(500).json({ error: "Failed to update withdrawal status" });
  } finally {
    client.release();
  }
});

// ── POST /admin/balance-adjust ────────────────────────────────────────────────
// Admin: manually credit or deduct a user's internal balance for a given asset.
router.post("/admin/balance-adjust", requireAdminToken, async (req, res) => {
  const { walletAddress, asset, amount, type, reason } = req.body as {
    walletAddress: string; asset: string; amount: string; type: "credit" | "deduct"; reason?: string;
  };

  if (!walletAddress || !asset || !amount || !type) {
    res.status(400).json({ error: "walletAddress, asset, amount, type are required" });
    return;
  }
  if (!["credit", "deduct"].includes(type)) {
    res.status(400).json({ error: "type must be 'credit' or 'deduct'" });
    return;
  }
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (type === "deduct") {
      const { rows } = await client.query<{ available: string }>(
        `SELECT available FROM user_balances WHERE wallet_address = $1::varchar AND asset_symbol = $2::varchar FOR UPDATE`,
        [walletAddress, asset],
      );
      const available = parseFloat(rows[0]?.available ?? "0");
      if (available < parsed) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: `Insufficient balance: ${available} ${asset} available` });
        return;
      }
      await client.query(
        `UPDATE user_balances SET available = available - $1::numeric, updated_at = now()
         WHERE wallet_address = $2::varchar AND asset_symbol = $3::varchar`,
        [parsed.toString(), walletAddress, asset],
      );
    } else {
      await client.query(
        `INSERT INTO user_balances (wallet_address, asset_symbol, available, updated_at)
         VALUES ($1::varchar, $2::varchar, $3::numeric, now())
         ON CONFLICT (wallet_address, asset_symbol)
         DO UPDATE SET available = user_balances.available + EXCLUDED.available, updated_at = now()`,
        [walletAddress, asset, parsed.toString()],
      );
    }

    await client.query("COMMIT");
    req.log.info({ walletAddress, asset, amount: parsed, type, reason }, "admin: manual balance adjustment");
    res.json({ success: true, walletAddress, asset, amount: parsed, type });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    req.log.error({ err }, "admin/balance-adjust: failed");
    res.status(500).json({ error: "Balance adjustment failed" });
  } finally {
    client.release();
  }
});

// ── GET /withdrawals/:walletAddress ──────────────────────────────────────────
// Returns the full withdrawal history for a wallet.
// Requires either a valid admin token or the X-Wallet-Address header matching
// the URL param (so only the wallet owner or admins can see history).
router.get("/withdrawals/:walletAddress", async (req, res) => {
  const adminToken = req.headers["x-admin-token"] as string | undefined;
  const callerHeader = (req.headers["x-wallet-address"] as string | undefined)?.toLowerCase();
  const paramWallet = req.params.walletAddress?.toLowerCase();
  const isAdmin = !!adminToken && isValidAdminToken(adminToken);
  const isSelf = callerHeader && callerHeader === paramWallet;
  if (!isAdmin && !isSelf) {
    res.status(401).json({ error: "Authentication required. Include X-Wallet-Address header matching the requested wallet, or a valid admin token." });
    return;
  }
  try {
    const { walletAddress } = req.params;
    if (!walletAddress) {
      res.status(400).json({ error: "walletAddress is required" });
      return;
    }

    const rows = await db
      .select()
      .from(withdrawalRequestsTable)
      .where(eq(withdrawalRequestsTable.walletAddress, walletAddress))
      .orderBy(desc(withdrawalRequestsTable.createdAt))
      .limit(100);

    res.json(rows.map(r => ({
      id:           r.id,
      asset:        r.asset,
      amount:       parseFloat(r.amount),
      network:      r.network,
      networkLabel: r.networkLabel,
      recipient:    r.recipient,
      fee:          r.fee,
      status:       r.status,
      txid:         r.txid,
      note:         r.note,
      arcTxid:      r.arcTxid,
      arcStatus:    r.arcStatus,
      createdAt:    r.createdAt,
      processedAt:  r.processedAt,
    })));
  } catch (err) {
    req.log.error({ err }, "withdrawals: failed to fetch history");
    res.status(500).json({ error: "Failed to fetch withdrawal history" });
  }
});

export default router;
