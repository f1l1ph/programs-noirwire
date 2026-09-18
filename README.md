# vault

A minimal Solana program written with Anchor: a simple SOL vault/wallet. Each
owner gets exactly one program-derived vault account that can hold native
SOL, deposited and withdrawn on demand.

## How it works

Every vault is a PDA (program-derived address) seeded from the literal string
`"vault"` and the owner's public key: `[b"vault", owner.key().as_ref()]`. It
is a plain system-owned account with no data of its own; it exists purely to
hold a lamport balance. Because the PDA's address is derived deterministically
from the owner's key, there is exactly one vault per owner, and only that
owner can ever authorize a withdrawal from it.

## Instructions

- **`initialize`** - creates the caller's vault PDA, funded to the
  rent-exempt minimum by the caller (`owner`, who signs and pays).
- **`deposit(amount: u64)`** - any signer can top up a given owner's vault by
  transferring `amount` lamports into it via a System Program transfer. The
  depositor does not need to be the vault's owner.
- **`withdraw(amount: u64)`** - only the vault's owner can withdraw. The
  owner must sign, and the program's account constraints ensure the supplied
  vault PDA was actually derived from that signer's own key - a mismatched
  owner simply produces the wrong PDA and the instruction fails. The
  instruction also rejects any withdrawal that exceeds the vault's current
  balance.

## Build and test

```bash
anchor build          # compile the program
anchor test            # local-validator integration tests (tests/vault.ts)
cargo test -p programs-noirwire  # unit tests (balance-check logic, PDA derivation)
npm run typecheck       # tsc --noEmit over the test suite
```

`anchor test` spins up a local validator and runs the Mocha/TypeScript
integration suite in `tests/vault.ts`: initialization, deposits (including a
non-owner depositor and multiple accumulating deposits), successful owner
withdrawals, a rejected non-owner withdrawal, a rejected over-withdrawal, two
owners' vaults staying fully independent, a rejected double-initialize,
zero-amount deposit/withdraw no-ops, full-balance draining (which removes the
account from the ledger), and a hand-crafted transaction proving the program
itself - not just the generated client - rejects a forged System Program
account.

`cargo test` runs Rust-level unit tests against the vault's balance-check
logic and its PDA derivation, with no validator needed.
