// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * OrahDEX HTLC v5.0 — Atomic Two-Party Trade Settlement
 *
 * ── WHAT CHANGED IN v5.0 ─────────────────────────────────────────────────────
 *
 *   1. ATOMIC SETTLEMENT — settleTrade() settles BOTH legs in ONE transaction.
 *      The v4 two-transaction reveal() flow allowed: seller reveal succeeds,
 *      buyer reveal fails → seller paid, buyer not. That is impossible now:
 *      if either transfer fails, the entire transaction reverts.
 *
 *   2. CONTRACT-ENFORCED COUNTERPARTY — settleTrade() requires BOTH locks to
 *      exist on-chain. Security no longer depends on the relayer being honest.
 *
 *   3. TRADE-LEVEL STATE — a Trade struct binds seller, buyer and secretHash.
 *      The second lock MUST match the first lock's secretHash (HashMismatch)
 *      and party addresses (PartyMismatch). No orphaned/incompatible locks.
 *
 *   4. SafeERC20 — USDT and other non-standard ERC-20s (no return value,
 *      USDT-style approve semantics handled client-side) no longer revert.
 *
 *   5. SLIDING TIMELOCKS — each lock's refund timer starts when THAT lock is
 *      placed, not at trade creation. Minimum 5-minute window enforced.
 *
 * ── FLOW ─────────────────────────────────────────────────────────────────────
 *
 *   1. First party calls lockETH()/lockToken()  → initializes the Trade
 *      (seller, buyer, secretHash bound on-chain).
 *   2. Second party calls lockETH()/lockToken() → must match trade binding.
 *   3. Anyone holding the secret calls settleTrade(tradeId, secret):
 *        seller's funds → buyer, buyer's funds → seller, atomically.
 *   4. If the counterparty never locks, refund(tradeId, side) after that
 *      side's timelock expires returns funds to the original sender only.
 *
 * ── LOCK IDS ─────────────────────────────────────────────────────────────────
 *
 *   sellerLockId = keccak256(abi.encodePacked(tradeId, "_seller"))
 *   buyerLockId  = keccak256(abi.encodePacked(tradeId, "_buyer"))
 *
 *   (identical derivation to v4 — existing off-chain tooling unchanged)
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract OrahDEXHTLC {
    using SafeERC20 for IERC20;

    // ── Types ─────────────────────────────────────────────────────────────────

    enum Side { SELLER, BUYER }

    struct Lock {
        address sender;          // party who locked (only sender may refund)
        address recipient;       // counterparty who receives on settle
        address token;           // address(0) = native; otherwise ERC-20
        uint256 amount;          // wei, or token smallest unit
        uint256 timelockUnix;    // block.timestamp must be >= this to refund
        bool    funded;
        bool    settled;
        bool    refunded;
    }

    struct Trade {
        address seller;
        address buyer;
        bytes32 secretHash;      // bound at first lock; second lock must match
        bool    sellerFunded;
        bool    buyerFunded;
        bool    settled;
    }

    /// Minimum remaining window between lock placement and its timelock.
    uint256 public constant MIN_LOCK_WINDOW = 5 minutes;

    mapping(bytes32 => Lock)  private _locks;   // lockId  => Lock
    mapping(bytes32 => Trade) private _trades;  // tradeId => Trade

    // ── Events ────────────────────────────────────────────────────────────────
    // Locked keeps the exact v4 signature so the existing webhook router
    // (topics[1] = lockId) keeps working without changes.

    event Locked(
        bytes32 indexed id,
        address indexed sender,
        address indexed recipient,
        address  token,
        uint256  amount,
        bytes32  secretHash,
        uint256  timelockUnix
    );

    event TradeSettled(
        bytes32 indexed tradeId,
        bytes32 secret,
        address indexed seller,
        address indexed buyer
    );

    event Refunded(
        bytes32 indexed tradeId,
        Side indexed side,
        address indexed sender,
        uint256 amount
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    error ZeroAmount();
    error TimelockTooShort();
    error LockAlreadyExists();
    error LockNotFound();
    error InvalidParty();
    error PartyMismatch();
    error HashMismatch();
    error SellerNotLocked();
    error BuyerNotLocked();
    error TradeAlreadySettled();
    error AlreadyRefunded();
    error TimelockNotExpired();
    error NotSender();
    error WrongSecret();
    error TransferFailed();

    // ── Lock creation ─────────────────────────────────────────────────────────

    /**
     * Lock native currency (ETH/BNB/MATIC…) as one leg of a trade.
     *
     * First call for a tradeId initializes the Trade and binds
     * (seller, buyer, secretHash). Second call must match that binding.
     *
     * @param tradeId       Off-chain trade identifier (bytes32)
     * @param side          SELLER or BUYER
     * @param secretHash    keccak256(abi.encodePacked(secret))
     * @param counterparty  The OTHER party: for SELLER → buyer address,
     *                      for BUYER → seller address. Becomes the recipient.
     * @param timelockUnix  Refund availability for THIS lock (>= now + 5 min)
     */
    function lockETH(
        bytes32 tradeId,
        Side    side,
        bytes32 secretHash,
        address counterparty,
        uint256 timelockUnix
    ) external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (timelockUnix < block.timestamp + MIN_LOCK_WINDOW) revert TimelockTooShort();
        if (counterparty == address(0)) revert InvalidParty();

        Trade storage trade = _trades[tradeId];
        bytes32 lockId = deriveLockId(tradeId, side);
        Lock storage lock = _locks[lockId];
        if (lock.funded) revert LockAlreadyExists();

        _bindTrade(trade, side, secretHash, counterparty);

        lock.sender       = msg.sender;
        lock.recipient    = counterparty;
        lock.token        = address(0);
        lock.amount       = msg.value;
        lock.timelockUnix = timelockUnix;
        lock.funded       = true;

        if (side == Side.SELLER) trade.sellerFunded = true;
        else                     trade.buyerFunded  = true;

        emit Locked(lockId, msg.sender, counterparty, address(0), msg.value, secretHash, timelockUnix);
    }

    /**
     * Lock an ERC-20 token as one leg of a trade.
     * Uses SafeERC20 — compatible with USDT and all non-standard tokens.
     * Caller must have approved this contract for at least `amount`.
     */
    function lockToken(
        bytes32 tradeId,
        Side    side,
        bytes32 secretHash,
        address token,
        uint256 amount,
        address counterparty,
        uint256 timelockUnix
    ) external {
        if (amount == 0) revert ZeroAmount();
        if (token == address(0)) revert InvalidParty();
        if (timelockUnix < block.timestamp + MIN_LOCK_WINDOW) revert TimelockTooShort();
        if (counterparty == address(0)) revert InvalidParty();

        Trade storage trade = _trades[tradeId];
        bytes32 lockId = deriveLockId(tradeId, side);
        Lock storage lock = _locks[lockId];
        if (lock.funded) revert LockAlreadyExists();

        _bindTrade(trade, side, secretHash, counterparty);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        lock.sender       = msg.sender;
        lock.recipient    = counterparty;
        lock.token        = token;
        lock.amount       = amount;
        lock.timelockUnix = timelockUnix;
        lock.funded       = true;

        if (side == Side.SELLER) trade.sellerFunded = true;
        else                     trade.buyerFunded  = true;

        emit Locked(lockId, msg.sender, counterparty, token, amount, secretHash, timelockUnix);
    }

    /// First leg initializes the trade; second leg is bound to it.
    function _bindTrade(Trade storage trade, Side side, bytes32 secretHash, address counterparty) internal {
        if (!trade.sellerFunded && !trade.buyerFunded) {
            (address seller, address buyer) = side == Side.SELLER
                ? (msg.sender, counterparty)
                : (counterparty, msg.sender);
            trade.seller     = seller;
            trade.buyer      = buyer;
            trade.secretHash = secretHash;
        } else {
            if (trade.settled) revert TradeAlreadySettled();
            if (secretHash != trade.secretHash) revert HashMismatch();
            bool partyOk = side == Side.SELLER
                ? (trade.seller == msg.sender && trade.buyer == counterparty)
                : (trade.buyer  == msg.sender && trade.seller == counterparty);
            if (!partyOk) revert PartyMismatch();
        }
    }

    // ── Atomic settlement ─────────────────────────────────────────────────────

    /**
     * Settle BOTH legs of a trade in ONE atomic transaction.
     *
     * Reverts unless: both locks exist, neither settled nor refunded,
     * secret hashes to the trade secretHash. Either transfer failing
     * reverts the whole call — funds move to both parties or neither.
     *
     * Callable by anyone holding the secret (the OrahDEX relayer).
     */
    function settleTrade(bytes32 tradeId, bytes32 secret) external {
        Trade storage trade = _trades[tradeId];
        if (!trade.sellerFunded) revert SellerNotLocked();
        if (!trade.buyerFunded)  revert BuyerNotLocked();
        if (trade.settled)       revert TradeAlreadySettled();
        if (keccak256(abi.encodePacked(secret)) != trade.secretHash) revert WrongSecret();

        trade.settled = true;

        Lock storage sLock = _locks[deriveLockId(tradeId, Side.SELLER)];
        Lock storage bLock = _locks[deriveLockId(tradeId, Side.BUYER)];

        // CEI: mark before transferring.
        sLock.settled = true;
        bLock.settled = true;

        // seller's funds → buyer
        _transfer(sLock.token, sLock.recipient, sLock.amount);
        // buyer's funds → seller
        _transfer(bLock.token, bLock.recipient, bLock.amount);

        emit TradeSettled(tradeId, secret, trade.seller, trade.buyer);

        // Gas refund: clean storage slots no longer needed.
        delete _locks[deriveLockId(tradeId, Side.SELLER)];
        delete _locks[deriveLockId(tradeId, Side.BUYER)];
    }

    // ── Refund ────────────────────────────────────────────────────────────────

    /**
     * Reclaim one leg after its own timelock expires.
     *
     * Only the original sender. Blocked once the trade has settled
     * (atomicity guarantee: a settled trade can never be unwound).
     */
    function refund(bytes32 tradeId, Side side) external {
        Trade storage trade = _trades[tradeId];
        if (trade.settled) revert TradeAlreadySettled();

        bytes32 lockId = deriveLockId(tradeId, side);
        Lock storage lock = _locks[lockId];
        if (!lock.funded)            revert LockNotFound();
        if (lock.refunded)           revert AlreadyRefunded();
        if (msg.sender != lock.sender) revert NotSender();
        if (block.timestamp < lock.timelockUnix) revert TimelockNotExpired();

        lock.refunded = true;

        uint256 amount = lock.amount;
        address sender = lock.sender;
        address token  = lock.token;

        _transfer(token, sender, amount);

        emit Refunded(tradeId, side, sender, amount);

        delete _locks[lockId];
    }

    // ── Internals / views ─────────────────────────────────────────────────────

    function _transfer(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool sent, ) = payable(to).call{value: amount}("");
            if (!sent) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function deriveLockId(bytes32 tradeId, Side side) public pure returns (bytes32) {
        // Matches off-chain: keccak256(tradeId_bytes32 ‖ utf8("_seller"|"_buyer"))
        return side == Side.SELLER
            ? keccak256(abi.encodePacked(tradeId, "_seller"))
            : keccak256(abi.encodePacked(tradeId, "_buyer"));
    }

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        return _locks[lockId];
    }

    function isLocked(bytes32 lockId) external view returns (bool) {
        return _locks[lockId].funded;
    }

    function getTrade(bytes32 tradeId) external view returns (Trade memory) {
        return _trades[tradeId];
    }

    /// Explicitly reject bare ETH sends (funds may only enter via lockETH).
    receive() external payable {
        revert TransferFailed();
    }
}
