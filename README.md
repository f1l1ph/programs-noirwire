# vault (retired)

> ## ⚠️ RETIRED. NOT IN USE. DO NOT DEPLOY TO MAINNET.
>
> This program has **no caller**. The NoirWire app stopped using it on
> 2026-09-23 and deleted every client path to it.
>
> It was removed because it was buying nothing. A Solana account is a
> keypair: SOL can be sent to an address that has never existed, and a
> private SPL transfer opens the recipient's token account as part of its own
> settlement, paid by the sender. So a per-owner PDA added a rent-exempt
> minimum that somebody had to fund, which in turn forced a subsidising
> relayer into existence, in exchange for no capability a bare keypair did
> not already have. Deleting the vault deleted the cost, the relayer, and
> every way to abuse either.
>
> The build is still here as a record and as a starting point if the vault
> ever needs to come back with a real authority model (the revocable-delegate
> idea below). It is deployed on devnet only and it is unaudited. Nothing
> here should hold real funds.

A minimal Solana program written with Anchor: a simple SOL vault. Each owner
gets exactly one program-derived account that can hold native SOL, deposited
and withdrawn on demand.

## How it works

Every vault is a PDA seeded from the literal string `"vault"` and the owner's
public key: `[b"vault", owner.key().as_ref()]`. It is a plain system-owned
account with no data of its own; it exists purely to hold a lamport balance.
Because the address is derived deterministically from the owner's key, there
is exactly one vault per owner, and only that owner can authorize a
withdrawal from it.

## Instructions

- **`initialize`** - creates the caller's vault PDA, funded to the
  rent-exempt minimum by the caller, who signs and pays.
- **`deposit(amount)`** - any signer can top up a given owner's vault through
  a System Program transfer. The depositor does not need to be the owner.
- **`withdraw(amount)`** - only the owner can withdraw, and only down to the
  rent-exempt floor. The account constraints ensure the supplied PDA was
  actually derived from the signer's own key, so a mismatched owner simply
  produces the wrong address and the instruction fails.

The rent-exempt minimum is deliberately **not** withdrawable. When the app
still used this program, that seed was paid by a shared relayer rather than
by the owner, so leaving it redeemable would have made every created account
worth draining. Enforcing the floor made a created account worth nothing to
an attacker and removed the need for any per-wallet rate limit.

## Build and test

```bash
anchor build                      # compile
anchor test                       # local-validator integration suite (tests/vault.ts)
cargo test -p programs-noirwire   # Rust unit tests, no validator needed
npm run typecheck                 # tsc --noEmit over the test suite
```

`anchor test` covers initialization, deposits including a non-owner
depositor, owner withdrawals, a rejected non-owner withdrawal, a rejected
over-withdrawal, two owners' vaults staying independent, a rejected
double-initialize, zero-amount no-ops, draining down to the rent floor, and a
hand-crafted transaction proving the program itself rejects a forged System
Program account.

## Security note

The deploy keypair that was previously committed to this repository is
**permanently compromised** and must never be funded or reused. Keypairs are
64-byte JSON arrays; `.gitignore` now excludes the common filenames, but the
only real protection is not writing one into a repository in the first place.

## If this comes back

The interesting version is not this one. A vault worth deploying would carry
an authority model: a permanent `owner` plus an optional `delegate` the
program checks in `withdraw`, with `set_delegate` and `revoke_delegate`
callable only by the owner. That turns "hand someone an account" into two
genuinely different products, a permanent ownership handoff and a revocable
delegation, where today handing over a derived key is irrevocable by
construction.
