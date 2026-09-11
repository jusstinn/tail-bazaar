// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FailureEscrow} from "../src/FailureEscrow.sol";

/// Minimal cheatcode surface (same address and selectors forge-std uses). Declared here so the
/// project has no external Solidity dependency or git submodule.
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
}

contract Rejector {
    // rejects ETH so withdraw() must revert with TransferFailed
    receive() external payable {
        revert("no");
    }
}

contract FailureEscrowTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address verifier = address(0xA11CE);
    address seller = address(0x5E11E7);
    address buyer = address(0xB0B);
    address stranger = address(0x51);

    uint64 constant DELIVERY_WINDOW = 3600;
    uint64 constant SETTLEMENT_WINDOW = 7200;
    uint256 constant PRICE = 0.001 ether;
    bytes32 constant LID = keccak256("listing-1");
    bytes32 constant COMMIT = keccak256("private package bytes with salt");
    bytes32 constant TERMS = keccak256("public summary bytes");

    FailureEscrow esc;

    function setUp() public {
        esc = new FailureEscrow(verifier, DELIVERY_WINDOW, SETTLEMENT_WINDOW);
        vm.deal(buyer, 1 ether);
        vm.deal(stranger, 1 ether);
        vm.deal(seller, 1 ether);
        vm.warp(1_000_000);
    }

    function _register() internal {
        vm.prank(verifier);
        esc.registerListing(LID, seller, PRICE, COMMIT, TERMS);
    }

    function _fund() internal {
        vm.prank(buyer);
        esc.fund{value: PRICE}(LID);
    }

    function _deliver() internal {
        vm.prank(seller);
        esc.markDelivered(LID, COMMIT);
    }

    // ---------------------------------------------------------------- success
    function testSuccessFlowCreditsSellerAndCountsOrder() public {
        _register();
        _fund();
        _deliver();
        vm.prank(verifier);
        esc.settle(LID, true);
        FailureEscrow.Listing memory l = esc.getListing(LID);
        require(l.status == FailureEscrow.Status.SettledValid, "status");
        require(esc.balances(seller) == PRICE, "seller credited");
        require(esc.balances(buyer) == 0, "buyer not credited");
        require(esc.settledOrders(seller) == 1, "settled count");
        uint256 before = seller.balance;
        vm.prank(seller);
        esc.withdraw();
        require(seller.balance == before + PRICE, "withdrawn");
        require(esc.balances(seller) == 0, "balance cleared");
        require(address(esc).balance == 0, "escrow empty");
    }

    function testTermsAreImmutableAndBoundToParties() public {
        _register();
        FailureEscrow.Listing memory l = esc.getListing(LID);
        require(l.seller == seller && l.price == PRICE && l.commitment == COMMIT && l.termsHash == TERMS, "terms");
        // re-registering the same id is impossible, even by the verifier
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongStatus.selector, FailureEscrow.Status.Listed));
        esc.registerListing(LID, stranger, 1, COMMIT, TERMS);
        _fund();
        l = esc.getListing(LID);
        require(l.buyer == buyer, "buyer bound");
        require(l.deliveryDeadline == uint64(block.timestamp) + DELIVERY_WINDOW, "delivery deadline");
        require(l.settlementDeadline == l.deliveryDeadline + SETTLEMENT_WINDOW, "settlement deadline");
    }

    // ------------------------------------------------------- invalid delivery
    function testInvalidDeliveryRefundsBuyer() public {
        _register();
        _fund();
        // seller delivers bytes that do not hash to the commitment; the verifier catches it off-chain
        vm.prank(seller);
        esc.markDelivered(LID, keccak256("tampered package"));
        vm.prank(verifier);
        esc.settle(LID, false);
        FailureEscrow.Listing memory l = esc.getListing(LID);
        require(l.status == FailureEscrow.Status.SettledInvalid, "status");
        require(esc.balances(buyer) == PRICE, "buyer credited");
        require(esc.balances(seller) == 0, "seller not credited");
        require(esc.settledOrders(seller) == 0, "no settled count");
        uint256 before = buyer.balance;
        vm.prank(buyer);
        esc.withdraw();
        require(buyer.balance == before + PRICE, "refund withdrawn");
    }

    function testCommitmentMismatchIsVisibleOnChain() public {
        _register();
        _fund();
        bytes32 wrong = keccak256("tampered package");
        vm.prank(seller);
        esc.markDelivered(LID, wrong);
        FailureEscrow.Listing memory l = esc.getListing(LID);
        require(l.deliveryHash == wrong && l.commitment == COMMIT && l.deliveryHash != l.commitment, "mismatch recorded");
    }

    // ------------------------------------------------------ timeout boundaries
    function testDeliveryDeadlineBoundary() public {
        _register();
        _fund();
        FailureEscrow.Listing memory l = esc.getListing(LID);
        // exactly at the deadline: delivery still allowed, timeout not yet claimable
        vm.warp(l.deliveryDeadline);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.DeadlineNotReached.selector, l.deliveryDeadline));
        esc.claimTimeout(LID);
        // one second later: delivery rejected, timeout refunds the buyer
        vm.warp(l.deliveryDeadline + 1);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.PastDeadline.selector, l.deliveryDeadline));
        esc.markDelivered(LID, COMMIT);
        vm.prank(stranger); // anyone may trigger it
        esc.claimTimeout(LID);
        l = esc.getListing(LID);
        require(l.status == FailureEscrow.Status.Refunded, "refunded");
        require(esc.balances(buyer) == PRICE, "buyer credited");
    }

    function testDeliveryExactlyAtDeadlineSucceeds() public {
        _register();
        _fund();
        FailureEscrow.Listing memory l = esc.getListing(LID);
        vm.warp(l.deliveryDeadline);
        _deliver();
        require(esc.getListing(LID).status == FailureEscrow.Status.Delivered, "delivered at boundary");
    }

    function testSettlementDeadlineBoundary() public {
        _register();
        _fund();
        _deliver();
        FailureEscrow.Listing memory l = esc.getListing(LID);
        vm.warp(l.settlementDeadline);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.DeadlineNotReached.selector, l.settlementDeadline));
        esc.claimTimeout(LID);
        vm.warp(l.settlementDeadline + 1);
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.PastDeadline.selector, l.settlementDeadline));
        esc.settle(LID, true);
        esc.claimTimeout(LID);
        require(esc.getListing(LID).status == FailureEscrow.Status.Refunded, "refunded after silent verifier");
        require(esc.balances(buyer) == PRICE, "buyer advantage: refund");
    }

    function testSettleExactlyAtDeadlineSucceeds() public {
        _register();
        _fund();
        _deliver();
        vm.warp(esc.getListing(LID).settlementDeadline);
        vm.prank(verifier);
        esc.settle(LID, true);
        require(esc.getListing(LID).status == FailureEscrow.Status.SettledValid, "settled at boundary");
    }

    function testTimeoutNotAvailableInOtherStates() public {
        _register();
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongStatus.selector, FailureEscrow.Status.Listed));
        esc.claimTimeout(LID);
        _fund();
        _deliver();
        vm.prank(verifier);
        esc.settle(LID, true);
        vm.warp(block.timestamp + DELIVERY_WINDOW + SETTLEMENT_WINDOW + 10);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongStatus.selector, FailureEscrow.Status.SettledValid));
        esc.claimTimeout(LID);
    }

    // --------------------------------------------------- unauthorized verifier
    function testOnlyVerifierCanRegister() public {
        vm.prank(seller);
        vm.expectRevert(FailureEscrow.NotVerifier.selector);
        esc.registerListing(LID, seller, PRICE, COMMIT, TERMS);
        vm.prank(stranger);
        vm.expectRevert(FailureEscrow.NotVerifier.selector);
        esc.registerListing(LID, seller, PRICE, COMMIT, TERMS);
    }

    function testOnlyVerifierCanSettle() public {
        _register();
        _fund();
        _deliver();
        vm.prank(buyer);
        vm.expectRevert(FailureEscrow.NotVerifier.selector);
        esc.settle(LID, false);
        vm.prank(seller);
        vm.expectRevert(FailureEscrow.NotVerifier.selector);
        esc.settle(LID, true);
    }

    // -------------------------------------------------------------- wrong buyer
    function testWrongBuyerCannotRequestRecheckAndSellerCannotFundOwnListing() public {
        _register();
        vm.prank(seller);
        vm.expectRevert(FailureEscrow.NotBuyer.selector);
        esc.fund{value: PRICE}(LID);
        _fund();
        vm.prank(stranger);
        vm.expectRevert(FailureEscrow.NotBuyer.selector);
        esc.requestRecheck(LID, "not my order");
        vm.prank(buyer);
        esc.requestRecheck(LID, "claim does not reproduce on my machine");
        // a recheck request moves no funds and changes no status
        require(esc.getListing(LID).status == FailureEscrow.Status.Funded, "status unchanged");
        require(esc.balances(buyer) == 0 && esc.balances(seller) == 0, "no funds moved");
    }

    function testOnlySellerCanMarkDelivered() public {
        _register();
        _fund();
        vm.prank(buyer);
        vm.expectRevert(FailureEscrow.NotSeller.selector);
        esc.markDelivered(LID, COMMIT);
        vm.prank(verifier);
        vm.expectRevert(FailureEscrow.NotSeller.selector);
        esc.markDelivered(LID, COMMIT);
    }

    function testSecondBuyerCannotFundFundedListing() public {
        _register();
        _fund();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongStatus.selector, FailureEscrow.Status.Funded));
        esc.fund{value: PRICE}(LID);
    }

    // ------------------------------------------------------- repeated settlement
    function testRepeatedSettlementReverts() public {
        _register();
        _fund();
        _deliver();
        vm.startPrank(verifier);
        esc.settle(LID, true);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongStatus.selector, FailureEscrow.Status.SettledValid));
        esc.settle(LID, false);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongStatus.selector, FailureEscrow.Status.SettledValid));
        esc.settle(LID, true);
        vm.stopPrank();
        require(esc.balances(seller) == PRICE && esc.settledOrders(seller) == 1, "credited once");
    }

    function testSettleRequiresDelivery() public {
        _register();
        _fund();
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongStatus.selector, FailureEscrow.Status.Funded));
        esc.settle(LID, true);
    }

    // ------------------------------------------------------------ wrong payment
    function testWrongPaymentReverts() public {
        _register();
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongPayment.selector, PRICE, PRICE - 1));
        esc.fund{value: PRICE - 1}(LID);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongPayment.selector, PRICE, PRICE + 1));
        esc.fund{value: PRICE + 1}(LID);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongPayment.selector, PRICE, 0));
        esc.fund{value: 0}(LID);
        vm.stopPrank();
        require(esc.getListing(LID).status == FailureEscrow.Status.Listed, "still listed");
    }

    function testFundUnknownListingReverts() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(FailureEscrow.WrongStatus.selector, FailureEscrow.Status.None));
        esc.fund{value: PRICE}(keccak256("nope"));
    }

    // ---------------------------------------------------------------- withdraw
    function testWithdrawNothingReverts() public {
        vm.prank(stranger);
        vm.expectRevert(FailureEscrow.NothingToWithdraw.selector);
        esc.withdraw();
    }

    function testWithdrawToRejectingReceiverRevertsAndKeepsBalance() public {
        Rejector r = new Rejector();
        vm.prank(verifier);
        esc.registerListing(LID, address(r), PRICE, COMMIT, TERMS);
        _fund();
        vm.prank(address(r));
        esc.markDelivered(LID, COMMIT);
        vm.prank(verifier);
        esc.settle(LID, true);
        vm.prank(address(r));
        vm.expectRevert(FailureEscrow.TransferFailed.selector);
        esc.withdraw();
        require(esc.balances(address(r)) == PRICE, "balance preserved");
    }

    // -------------------------------------------------------------- constructor
    function testConstructorRejectsZeroValues() public {
        vm.expectRevert(FailureEscrow.ZeroAddress.selector);
        new FailureEscrow(address(0), 1, 1);
        vm.expectRevert(FailureEscrow.ZeroValue.selector);
        new FailureEscrow(verifier, 0, 1);
        vm.expectRevert(FailureEscrow.ZeroValue.selector);
        new FailureEscrow(verifier, 1, 0);
    }

    function testRegisterRejectsZeroTerms() public {
        vm.startPrank(verifier);
        vm.expectRevert(FailureEscrow.ZeroAddress.selector);
        esc.registerListing(LID, address(0), PRICE, COMMIT, TERMS);
        vm.expectRevert(FailureEscrow.ZeroValue.selector);
        esc.registerListing(LID, seller, 0, COMMIT, TERMS);
        vm.expectRevert(FailureEscrow.ZeroValue.selector);
        esc.registerListing(LID, seller, PRICE, bytes32(0), TERMS);
        vm.expectRevert(FailureEscrow.ZeroValue.selector);
        esc.registerListing(LID, seller, PRICE, COMMIT, bytes32(0));
        vm.stopPrank();
    }
}
