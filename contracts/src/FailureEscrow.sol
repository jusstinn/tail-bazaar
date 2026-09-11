// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FailureEscrow - verifier-adjudicated escrow for private failure-scenario packages
/// @notice Native-ETH escrow with immutable per-listing terms. The named verifier registers
///         listings (so an arbitrary seller cannot forge a "verified" status), a buyer funds
///         exactly the listed price, the seller marks delivery, and the verifier settles once.
///         Deadlines guarantee that funds can never be locked forever. All payouts are
///         pull-payments via withdraw().
///
///         State machine (one terminal transition per listing):
///           None --registerListing(verifier)--> Listed
///           Listed --fund(buyer, msg.value == price)--> Funded
///           Funded --markDelivered(seller, t <= deliveryDeadline)--> Delivered
///           Delivered --settle(verifier, valid, t <= settlementDeadline)--> SettledValid | SettledInvalid
///           Funded --claimTimeout(anyone, t > deliveryDeadline)--> Refunded
///           Delivered --claimTimeout(anyone, t > settlementDeadline)--> Refunded
///
///         Buyer advantage (documented): if the seller never delivers, or the verifier never
///         settles in time, the buyer is refunded. A seller therefore depends on a responsive
///         verifier; the verifier cannot take funds for itself in any transition.
///         requestRecheck() lets a buyer complain on the record; it moves no funds and cannot
///         reverse a valid settlement. The verifier adjudicates correctness; this contract does
///         not (and cannot) check that a delivered package is semantically correct.
contract FailureEscrow {
    enum Status {
        None,
        Listed,
        Funded,
        Delivered,
        SettledValid,
        SettledInvalid,
        Refunded
    }

    struct Listing {
        address seller;
        address buyer;
        uint256 price; // wei, exact amount required by fund()
        bytes32 commitment; // keccak256 of the canonical private package (includes a random salt)
        bytes32 termsHash; // keccak256 of the canonical public summary / terms document
        bytes32 deliveryHash; // hash the seller asserts for the delivered bytes
        uint64 fundedAt;
        uint64 deliveryDeadline;
        uint64 settlementDeadline;
        Status status;
    }

    address public immutable verifier;
    uint64 public immutable deliveryWindow; // seconds after funding in which the seller must deliver
    uint64 public immutable settlementWindow; // seconds after delivery in which the verifier must settle

    mapping(bytes32 => Listing) private _listings;
    mapping(address => uint256) public balances; // withdrawable ETH per account
    mapping(address => uint256) public settledOrders; // count of SettledValid orders per seller

    event ListingRegistered(bytes32 indexed listingId, address indexed seller, uint256 price, bytes32 commitment, bytes32 termsHash);
    event Funded(bytes32 indexed listingId, address indexed buyer, uint256 amount, uint64 deliveryDeadline, uint64 settlementDeadline);
    event Delivered(bytes32 indexed listingId, bytes32 deliveryHash);
    event Settled(bytes32 indexed listingId, bool valid, address indexed creditedTo, uint256 amount);
    event TimeoutRefunded(bytes32 indexed listingId, address indexed buyer, uint256 amount, Status fromStatus);
    event RecheckRequested(bytes32 indexed listingId, address indexed buyer, string reason);
    event Withdrawn(address indexed account, uint256 amount);

    error NotVerifier();
    error NotSeller();
    error NotBuyer();
    error WrongStatus(Status current);
    error WrongPayment(uint256 expected, uint256 actual);
    error PastDeadline(uint64 deadline);
    error DeadlineNotReached(uint64 deadline);
    error ZeroAddress();
    error ZeroValue();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(address verifier_, uint64 deliveryWindow_, uint64 settlementWindow_) {
        if (verifier_ == address(0)) revert ZeroAddress();
        if (deliveryWindow_ == 0 || settlementWindow_ == 0) revert ZeroValue();
        verifier = verifier_;
        deliveryWindow = deliveryWindow_;
        settlementWindow = settlementWindow_;
    }

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert NotVerifier();
        _;
    }

    function getListing(bytes32 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    /// @notice Only the verifier may register: a listing's existence is the verifier's statement
    ///         that it re-ran the scenario and computed `commitment` from the private package.
    function registerListing(bytes32 listingId, address seller, uint256 price, bytes32 commitment, bytes32 termsHash)
        external
        onlyVerifier
    {
        Listing storage l = _listings[listingId];
        if (l.status != Status.None) revert WrongStatus(l.status);
        if (seller == address(0)) revert ZeroAddress();
        if (price == 0 || commitment == bytes32(0) || termsHash == bytes32(0)) revert ZeroValue();
        l.seller = seller;
        l.price = price;
        l.commitment = commitment;
        l.termsHash = termsHash;
        l.status = Status.Listed;
        emit ListingRegistered(listingId, seller, price, commitment, termsHash);
    }

    /// @notice Any account except the seller may fund with exactly `price`. Binds the buyer and
    ///         fixes both deadlines.
    function fund(bytes32 listingId) external payable {
        Listing storage l = _listings[listingId];
        if (l.status != Status.Listed) revert WrongStatus(l.status);
        if (msg.value != l.price) revert WrongPayment(l.price, msg.value);
        if (msg.sender == l.seller) revert NotBuyer();
        l.buyer = msg.sender;
        l.fundedAt = uint64(block.timestamp);
        l.deliveryDeadline = uint64(block.timestamp) + deliveryWindow;
        l.settlementDeadline = l.deliveryDeadline + settlementWindow;
        l.status = Status.Funded;
        emit Funded(listingId, msg.sender, msg.value, l.deliveryDeadline, l.settlementDeadline);
    }

    /// @notice The seller asserts delivery (off-chain, to the authenticated buyer) before the
    ///         delivery deadline. `deliveryHash` is the seller's claim about the delivered bytes;
    ///         the verifier checks it against `commitment` and the actual delivered package.
    function markDelivered(bytes32 listingId, bytes32 deliveryHash) external {
        Listing storage l = _listings[listingId];
        if (l.status != Status.Funded) revert WrongStatus(l.status);
        if (msg.sender != l.seller) revert NotSeller();
        if (block.timestamp > l.deliveryDeadline) revert PastDeadline(l.deliveryDeadline);
        l.deliveryHash = deliveryHash;
        l.status = Status.Delivered;
        emit Delivered(listingId, deliveryHash);
    }

    /// @notice One terminal transition by the verifier, at or before the settlement deadline.
    ///         valid   -> price credited to the seller, seller's settled-order count increments
    ///         invalid -> price credited to the buyer
    function settle(bytes32 listingId, bool valid) external onlyVerifier {
        Listing storage l = _listings[listingId];
        if (l.status != Status.Delivered) revert WrongStatus(l.status);
        if (block.timestamp > l.settlementDeadline) revert PastDeadline(l.settlementDeadline);
        if (valid) {
            l.status = Status.SettledValid;
            balances[l.seller] += l.price;
            settledOrders[l.seller] += 1;
            emit Settled(listingId, true, l.seller, l.price);
        } else {
            l.status = Status.SettledInvalid;
            balances[l.buyer] += l.price;
            emit Settled(listingId, false, l.buyer, l.price);
        }
    }

    /// @notice Anyone may trigger a refund to the buyer strictly after the relevant deadline:
    ///         undelivered after the delivery deadline, or unsettled after the settlement deadline.
    function claimTimeout(bytes32 listingId) external {
        Listing storage l = _listings[listingId];
        Status from = l.status;
        if (from == Status.Funded) {
            if (block.timestamp <= l.deliveryDeadline) revert DeadlineNotReached(l.deliveryDeadline);
        } else if (from == Status.Delivered) {
            if (block.timestamp <= l.settlementDeadline) revert DeadlineNotReached(l.settlementDeadline);
        } else {
            revert WrongStatus(from);
        }
        l.status = Status.Refunded;
        balances[l.buyer] += l.price;
        emit TimeoutRefunded(listingId, l.buyer, l.price, from);
    }

    /// @notice A bound buyer may ask the verifier to re-check a delivery. Emits an event only.
    function requestRecheck(bytes32 listingId, string calldata reason) external {
        Listing storage l = _listings[listingId];
        if (l.status == Status.None || l.status == Status.Listed) revert WrongStatus(l.status);
        if (msg.sender != l.buyer) revert NotBuyer();
        emit RecheckRequested(listingId, msg.sender, reason);
    }

    /// @notice Pull payment. Checks-effects-interactions; no reentrancy window with a live balance.
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }
}
