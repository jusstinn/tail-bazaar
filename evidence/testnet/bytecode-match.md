# Deployed bytecode vs the repository source (checked after the P1–P4 polish pass)

The polish pass changed only off-chain code (`web/`, `sim/`, docs). `contracts/` has not been touched
since commit `8c9056d`, which predates the Base Sepolia deployment commit `164843c`, so the recorded
receipts in this directory remain valid and **no redeployment was needed or performed**.

Checked directly against the chain:

```bash
forge inspect FailureEscrow deployedBytecode                  # local build, immutables zeroed
cast code 0xfadf11662C46c0214B0A40938a26FB8f0CD785A3 \
  --rpc-url https://sepolia.base.org                          # deployed runtime bytecode
```

Both are 4570 bytes (9140 hex characters). They are identical except at the positions where the
compiler bakes in the contract's three `immutable` values, which `forge inspect` reports as zeros:

| Differing run (hex-char offsets) | On chain | What it is |
|---|---|---|
| 670–709, 4526–4565, 6384–6423 | `e592c7da96cc42344952c452377ebcc7cc0982ae` | `verifier` — the deployer/verifier address `0xe592C7DA96Cc42344952C452377eBCc7Cc0982AE` |
| 1485–1486, 5835–5836 | `e10` | `deliveryWindow` = 3600 s (`DELIVERY_WINDOW_S`) |
| 1172–1174, 6022–6024 | `1c20` | `settlementWindow` = 7200 s (`SETTLEMENT_WINDOW_S`) |

No other byte differs, so the deployed contract is the one built from this repository's current
`contracts/src/FailureEscrow.sol` with the constructor arguments recorded in `deployment.json`. This
is consistent with the independent source verification already on record (Basescan "Pass - Verified",
Sourcify and Blockscout; see `verify-*.log`).
