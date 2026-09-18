use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount, Transfer};

declare_id!("5aqYNsJsmRuasaFMMWAF2s94r1bTuXZC46A6Ro9C82GY");

/// Pure balance check backing `withdraw`: the vault must hold at least
/// `amount` lamports for the withdrawal to proceed.
fn ensure_sufficient_funds(balance: u64, amount: u64) -> Result<()> {
    require!(balance >= amount, VaultError::InsufficientFunds);
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
        ensure_sufficient_funds(ctx.accounts.vault.lamports(), amount)?;

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
    #[msg("Withdrawal amount exceeds vault balance")]
    InsufficientFunds,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_withdrawing_the_exact_balance() {
        assert!(ensure_sufficient_funds(1_000, 1_000).is_ok());
    }

    #[test]
    fn rejects_withdrawing_more_than_the_balance() {
        let err = ensure_sufficient_funds(1_000, 1_001).unwrap_err();
        assert_eq!(err, VaultError::InsufficientFunds.into());
    }

    #[test]
    fn allows_a_zero_amount_withdrawal_as_a_no_op() {
        // A zero-amount withdrawal never exceeds any balance, including an
        // empty vault, so it is treated as a valid no-op rather than an error.
        assert!(ensure_sufficient_funds(0, 0).is_ok());
        assert!(ensure_sufficient_funds(1_000, 0).is_ok());
    }

    #[test]
    fn handles_the_u64_max_boundary() {
        assert!(ensure_sufficient_funds(u64::MAX, u64::MAX).is_ok());
        assert!(ensure_sufficient_funds(u64::MAX - 1, u64::MAX).is_err());
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
