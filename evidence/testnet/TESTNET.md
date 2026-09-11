# Base Sepolia evidence (public testnet, test ETH only)

Generated 2026-09-11T06:33:15.401Z by the marketplace pipeline in testnet mode. Every hash below is a real transaction on chain id 84532; receipts are in `receipts/`.

## Contract

- FailureEscrow: [0xfadf11662C46c0214B0A40938a26FB8f0CD785A3](https://sepolia.basescan.org/address/0xfadf11662C46c0214B0A40938a26FB8f0CD785A3)
- Deployment tx: [0x1bbee5a525cdeb642cb7058c3b26b4d1662fbd2549d22ea161c81394f84fbc7d](https://sepolia.basescan.org/tx/0x1bbee5a525cdeb642cb7058c3b26b4d1662fbd2549d22ea161c81394f84fbc7d) (block 46669937)
- Verifier (deployer): 0xe592C7DA96Cc42344952C452377eBCc7Cc0982AE
- Source verification: sourcify=ok, blockscout=ok, basescan=ok

## Order 1: SETTLED_VALID

- Listing id: 0x33596e9766aa7f555f0b143cac5caaac90476bed0ae4903d5930425e6ffe7e21
- Commitment (on chain): 0x76f1bcb4bf668acef7f39260e92998735c73358a7885dde127226a7649c9657b
- Terms hash: 0x35f4f970a6fc497c86c2ae2a3b129758e66be77b422fc8435f87f6fac97f4956
- Severity band: low; verification VERIFIED (exact-trajectory-hash)
- Price: 200000000000000 wei
- registerListing (verifier): [0x21e051e3751c16398107edf64e0a25321098347848b46679739ce49d5b11d38e](https://sepolia.basescan.org/tx/0x21e051e3751c16398107edf64e0a25321098347848b46679739ce49d5b11d38e)
- fund (buyer): [0x68b58fa29847774beea9e774b62dacdb99368e17f83476f3be15aedf5574b8cd](https://sepolia.basescan.org/tx/0x68b58fa29847774beea9e774b62dacdb99368e17f83476f3be15aedf5574b8cd)
- markDelivered (seller): [0x16cf64957cb537bf2692dfd68dd77487b32c9ae3480b93f52ddf49957d1899d8](https://sepolia.basescan.org/tx/0x16cf64957cb537bf2692dfd68dd77487b32c9ae3480b93f52ddf49957d1899d8)
- settle(true) (verifier): [0xfe906a38e73e8551862518fcb6b65ff0e9496d7732af6dc4b88d227f06417a16](https://sepolia.basescan.org/tx/0xfe906a38e73e8551862518fcb6b65ff0e9496d7732af6dc4b88d227f06417a16)
- withdraw (seller): [0x23b836ec4455c5daeb50c57ade1825b930a7f1935e385c8239025e655924ef7a](https://sepolia.basescan.org/tx/0x23b836ec4455c5daeb50c57ade1825b930a7f1935e385c8239025e655924ef7a)
- Verifier delivery check: VALID - delivered package hashes to the on-chain commitment and matches the advertised terms

## Order 2: SETTLED_INVALID

- Listing id: 0xed8898fbb605df949fe113853ba6f7ccd0c5933678129c21f27a2f8f41b373bd
- Commitment (on chain): 0x09769fd75c928f95ef9e4ee9611f60fb230d9d4e0c4c557ddb533cda98fca894
- Terms hash: 0x777e4b4750d889d5d079d881ddbec376c7264fc0fac1f6feaec0ffce9f16cc8d
- Severity band: low; verification VERIFIED (exact-trajectory-hash)
- Price: 200000000000000 wei
- registerListing (verifier): [0xd344757a26a98e93a6c7ec8f226809c48d8c2b0c4cbdf3902d59eb73fe5cff70](https://sepolia.basescan.org/tx/0xd344757a26a98e93a6c7ec8f226809c48d8c2b0c4cbdf3902d59eb73fe5cff70)
- fund (buyer): [0x690b55bd90a1a356f2b1b27cb38b699bc7342446dfb62eeb4cfbb817d5982a9d](https://sepolia.basescan.org/tx/0x690b55bd90a1a356f2b1b27cb38b699bc7342446dfb62eeb4cfbb817d5982a9d)
- markDelivered (seller): [0xc624154fcab5df109c102722a62e708640481a465718e5ae5cd28118583419ad](https://sepolia.basescan.org/tx/0xc624154fcab5df109c102722a62e708640481a465718e5ae5cd28118583419ad)
- requestRecheck (buyer): [0x20fd4e8076e7a70bcde2ade9a5cb8d91a79a395d9a144d00387d344318e1c1aa](https://sepolia.basescan.org/tx/0x20fd4e8076e7a70bcde2ade9a5cb8d91a79a395d9a144d00387d344318e1c1aa)
- settle(false) (verifier): [0x248f5c0f6998f612351de450f2a0db435d4b52ec5cba20ab9dfcc942fff074c3](https://sepolia.basescan.org/tx/0x248f5c0f6998f612351de450f2a0db435d4b52ec5cba20ab9dfcc942fff074c3)
- withdraw refund (buyer): [0x66cb7055332caaee3dcc2eaf880dac714a8ca81ad1f51bdf344c9602718709d3](https://sepolia.basescan.org/tx/0x66cb7055332caaee3dcc2eaf880dac714a8ca81ad1f51bdf344c9602718709d3)
- Verifier delivery check: INVALID - COMMITMENT MISMATCH: delivered bytes do not hash to the on-chain commitment

