import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { Vault } from "../target/types/vault";

describe("vault", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const baseProvider = anchor.getProvider() as anchor.AnchorProvider;
  const idl = (anchor.workspace.vault as Program<Vault>).idl;

  async function airdrop(pubkey: PublicKey, lamports: number): Promise<void> {
    const signature = await baseProvider.connection.requestAirdrop(pubkey, lamports);
    const latestBlockhash = await baseProvider.connection.getLatestBlockhash();
    await baseProvider.connection.confirmTransaction({
      signature,
      ...latestBlockhash,
    });
  }

  /**
   * Builds a Program bound to a freshly-generated, modestly-funded keypair
   * so it can act as both the fee payer and the vault `owner`. The
   * validator's default provider wallet holds hundreds of millions of SOL,
   * which is well beyond Number.MAX_SAFE_INTEGER in lamports and makes plain
   * JS-number balance arithmetic on it imprecise.
   */
  async function newFundedOwner(solAmount: number): Promise<{
    owner: Keypair;
    program: Program<Vault>;
    provider: anchor.AnchorProvider;
  }> {
    const owner = Keypair.generate();
    await airdrop(owner.publicKey, solAmount * LAMPORTS_PER_SOL);
    const provider = new anchor.AnchorProvider(
      baseProvider.connection,
      new anchor.Wallet(owner),
      anchor.AnchorProvider.defaultOptions()
    );
    const program = new Program<Vault>(idl, provider);
    return { owner, program, provider };
  }

  async function getConfirmedTransaction(connection: anchor.web3.Connection, signature: string) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta) {
        return tx;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`transaction ${signature} was not found after confirmation`);
  }

  /**
   * Reads how a single account's lamport balance moved within one confirmed
   * transaction, straight from its preBalances/postBalances, so the result
   * already nets out the transaction fee with no separate getBalance race.
   */
  function balanceDelta(
    tx: NonNullable<Awaited<ReturnType<typeof getConfirmedTransaction>>>,
    pubkey: PublicKey
  ): number {
    const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;
    const index = accountKeys.findIndex((key) => key.equals(pubkey));
    if (index === -1) {
      throw new Error(`account ${pubkey.toBase58()} not found in transaction`);
    }
    return tx.meta!.postBalances[index] - tx.meta!.preBalances[index];
  }

  function vaultPdaFor(owner: PublicKey, programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], programId);
    return pda;
  }

  it("initializes the vault at the expected PDA, empty", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        system_program: SystemProgram.programId,
      })
      .rpc();

    const vaultAccount = await baseProvider.connection.getAccountInfo(vaultPda);
    assert.isNotNull(vaultAccount);
    assert.ok(vaultAccount!.owner.equals(SystemProgram.programId));
    assert.equal(vaultAccount!.data.length, 0);

    const rentExemptMinimum = await baseProvider.connection.getMinimumBalanceForRentExemption(0);
    assert.equal(vaultAccount!.lamports, rentExemptMinimum);
  });

  it("increases the vault balance on deposit", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey, vault: vaultPda, system_program: SystemProgram.programId })
      .rpc();

    const balanceBefore = await baseProvider.connection.getBalance(vaultPda);
    const depositAmount = 0.5 * LAMPORTS_PER_SOL;

    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        owner: owner.publicKey,
        vault: vaultPda,
        system_program: SystemProgram.programId,
      })
      .rpc();

    const balanceAfter = await baseProvider.connection.getBalance(vaultPda);
    assert.equal(balanceAfter - balanceBefore, depositAmount);
  });

  it("lets the owner withdraw, decreasing the vault and increasing the owner's balance", async () => {
    const { owner, program, provider } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey, vault: vaultPda, system_program: SystemProgram.programId })
      .rpc();

    const depositAmount = 0.5 * LAMPORTS_PER_SOL;
    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        owner: owner.publicKey,
        vault: vaultPda,
        system_program: SystemProgram.programId,
      })
      .rpc();

    const withdrawAmount = 0.2 * LAMPORTS_PER_SOL;
    const signature = await program.methods
      .withdraw(new BN(withdrawAmount))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        system_program: SystemProgram.programId,
      })
      .rpc();

    const tx = await getConfirmedTransaction(provider.connection, signature);
    const fee = tx.meta!.fee;

    const vaultDelta = balanceDelta(tx, vaultPda);
    const ownerDelta = balanceDelta(tx, owner.publicKey);

    assert.equal(vaultDelta, -withdrawAmount);
    assert.equal(ownerDelta, withdrawAmount - fee);
  });

  it("rejects a withdrawal signed by a keypair that is not the vault's owner", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey, vault: vaultPda, system_program: SystemProgram.programId })
      .rpc();

    const depositAmount = 0.3 * LAMPORTS_PER_SOL;
    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        owner: owner.publicKey,
        vault: vaultPda,
        system_program: SystemProgram.programId,
      })
      .rpc();

    const { owner: intruder, program: intruderProgram } = await newFundedOwner(1);

    let rejected = false;
    try {
      await intruderProgram.methods
        .withdraw(new BN(1_000))
        .accounts({
          owner: intruder.publicKey,
          vault: vaultPda,
          system_program: SystemProgram.programId,
        })
        .rpc();
    } catch (_err) {
      rejected = true;
    }

    assert.isTrue(rejected, "withdrawal by a non-owner signer should have been rejected");
  });

  it("rejects withdrawing more than the vault's balance", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey, vault: vaultPda, system_program: SystemProgram.programId })
      .rpc();

    const depositAmount = 0.3 * LAMPORTS_PER_SOL;
    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        owner: owner.publicKey,
        vault: vaultPda,
        system_program: SystemProgram.programId,
      })
      .rpc();

    const vaultBalance = await baseProvider.connection.getBalance(vaultPda);
    const tooMuch = vaultBalance + LAMPORTS_PER_SOL;

    let rejected = false;
    try {
      await program.methods
        .withdraw(new BN(tooMuch))
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          system_program: SystemProgram.programId,
        })
        .rpc();
    } catch (_err) {
      rejected = true;
    }

    assert.isTrue(rejected, "withdrawing more than the vault balance should have been rejected");
  });
});
