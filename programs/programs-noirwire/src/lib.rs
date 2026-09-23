use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount, Transfer};

declare_id!("5aqYNsJsmRuasaFMMWAF2s94r1bTuXZC46A6Ro9C82GY");

/// The lamports a vault may actually pay out: everything above the
/// rent-exempt minimum it must retain to stay alive on the ledger.
fn withdrawable_lamports(balance: u64, rent_exempt_minimum: u64) -> u64 {
    balance.saturating_sub(rent_exempt_minimum)
}

/// Pure balance check backing `withdraw`.
///
/// The rent-exempt minimum is deliberately **not** withdrawable. A vault's
/// rent-exemption is seeded by the shared relayer rather than by the owner,
/// so allowing a drain to zero would turn every account creation into a way
/// to mint relayer-funded, redeemable SOL: create, withdraw the seed, repeat.
/// Locking the minimum in place makes the subsidy a sunk cost to whoever
/// spends it and worth nothing to whoever receives it, which removes the
/// profit motive without needing to know who requested the account - the
/// thing a per-funding-wallet cap could only learn by re-linking the funding
/// wallet to the account it just paid for.
///
/// No depositor is out of pocket: only the seeded minimum is held back, never
/// a lamport any user put in.
fn ensure_sufficient_funds(balance: u64, amount: u64, rent_exempt_minimum: u64) -> Result<()> {
    require!(
        amount <= withdrawable_lamports(balance, rent_exempt_minimum),
        VaultError::InsufficientFunds
    );
    Ok(())
}

#[program]
pub mod vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let bump = ctx.bumps.vault;
        let owner_key = ctx.accounts.owner.key();
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let space: u64 = 0;
        let lamports = Rent::get()?.minimum_balance(space as usize);

        let cpi_accounts = CreateAccount {
            from: ctx.accounts.owner.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        system_program::create_account(cpi_ctx, lamports, space, &system_program::ID)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        system_program::transfer(cpi_ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let rent_exempt_minimum = Rent::get()?.minimum_balance(0);
        ensure_sufficient_funds(ctx.accounts.vault.lamports(), amount, rent_exempt_minimum)?;

        let owner_key = ctx.accounts.owner.key();
        let bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.owner.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        system_program::transfer(cpi_ctx, amount)
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// CHECK: the owner whose vault is the deposit destination; does not need to sign
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum VaultError {
    #[msg("Withdrawal amount exceeds the balance above the vault's rent-exempt minimum")]
    InsufficientFunds,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for a 0-byte account's rent-exempt minimum, the amount the
    /// relayer seeds into every vault it creates.
    const SEED: u64 = 890_880;

    #[test]
    fn allows_withdrawing_everything_above_the_rent_floor() {
        assert!(ensure_sufficient_funds(SEED + 1_000, 1_000, SEED).is_ok());
    }

    #[test]
    fn rejects_draining_the_relayer_seeded_rent_exemption() {
        // The create-and-drain exploit: a freshly created vault holds only the
        // relayer's seed, and withdrawing it would pay the caller real SOL out
        // of a shared wallet for every account they create.
        let err = ensure_sufficient_funds(SEED, SEED, SEED).unwrap_err();
        assert_eq!(err, VaultError::InsufficientFunds.into());

        let err = ensure_sufficient_funds(SEED + 1_000, SEED + 1_000, SEED).unwrap_err();
        assert_eq!(err, VaultError::InsufficientFunds.into());
    }

    #[test]
    fn rejects_withdrawing_more_than_the_balance() {
        let err = ensure_sufficient_funds(SEED + 1_000, SEED + 1_001, SEED).unwrap_err();
        assert_eq!(err, VaultError::InsufficientFunds.into());
    }

    #[test]
    fn allows_a_zero_amount_withdrawal_as_a_no_op() {
        assert!(ensure_sufficient_funds(0, 0, SEED).is_ok());
        assert!(ensure_sufficient_funds(SEED, 0, SEED).is_ok());
        assert!(ensure_sufficient_funds(SEED + 1_000, 0, SEED).is_ok());
    }

    #[test]
    fn treats_a_vault_below_the_floor_as_having_nothing_to_withdraw() {
        // Never underflows into a huge withdrawable figure.
        assert_eq!(withdrawable_lamports(0, SEED), 0);
        assert_eq!(withdrawable_lamports(SEED - 1, SEED), 0);
        assert!(ensure_sufficient_funds(SEED - 1, 1, SEED).is_err());
    }

    #[test]
    fn a_zero_rent_floor_still_allows_a_full_drain() {
        // The floor is whatever the runtime reports; zero must not be special-cased.
        assert!(ensure_sufficient_funds(1_000, 1_000, 0).is_ok());
    }

    #[test]
    fn handles_the_u64_max_boundary() {
        assert!(ensure_sufficient_funds(u64::MAX, u64::MAX - SEED, SEED).is_ok());
        assert!(ensure_sufficient_funds(u64::MAX, u64::MAX, SEED).is_err());
        assert!(ensure_sufficient_funds(u64::MAX - 1, u64::MAX, SEED).is_err());
    }

    #[test]
    fn same_owner_derives_the_identical_vault_address_and_bump() {
        let owner = Pubkey::new_unique();
        let (pda_a, bump_a) = Pubkey::find_program_address(&[b"vault", owner.as_ref()], &crate::ID);
        let (pda_b, bump_b) = Pubkey::find_program_address(&[b"vault", owner.as_ref()], &crate::ID);
        assert_eq!(pda_a, pda_b);
        assert_eq!(bump_a, bump_b);
    }

    #[test]
    fn different_owners_derive_different_vault_addresses() {
        let owner_a = Pubkey::new_unique();
        let owner_b = Pubkey::new_unique();
        let (pda_a, _) = Pubkey::find_program_address(&[b"vault", owner_a.as_ref()], &crate::ID);
        let (pda_b, _) = Pubkey::find_program_address(&[b"vault", owner_b.as_ref()], &crate::ID);
        assert_ne!(pda_a, pda_b);
    }
}
