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
        owner: owner.publicKey
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
      .accounts({ owner: owner.publicKey })
      .rpc();

    const balanceBefore = await baseProvider.connection.getBalance(vaultPda);
    const depositAmount = 0.5 * LAMPORTS_PER_SOL;

    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        owner: owner.publicKey
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
      .accounts({ owner: owner.publicKey })
      .rpc();

    const depositAmount = 0.5 * LAMPORTS_PER_SOL;
    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        owner: owner.publicKey
      })
      .rpc();

    const withdrawAmount = 0.2 * LAMPORTS_PER_SOL;
    const signature = await program.methods
      .withdraw(new BN(withdrawAmount))
      .accounts({
        owner: owner.publicKey
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
      .accounts({ owner: owner.publicKey })
      .rpc();

    const depositAmount = 0.3 * LAMPORTS_PER_SOL;
    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        owner: owner.publicKey
      })
      .rpc();

    const { owner: intruder, program: intruderProgram } = await newFundedOwner(1);

    let rejected = false;
    try {
      await intruderProgram.methods
        .withdraw(new BN(1_000))
        .accounts({
          owner: intruder.publicKey
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
      .accounts({ owner: owner.publicKey })
      .rpc();

    const depositAmount = 0.3 * LAMPORTS_PER_SOL;
    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        owner: owner.publicKey
      })
      .rpc();

    const vaultBalance = await baseProvider.connection.getBalance(vaultPda);
    const tooMuch = vaultBalance + LAMPORTS_PER_SOL;

    let rejected = false;
    try {
      await program.methods
        .withdraw(new BN(tooMuch))
        .accounts({
          owner: owner.publicKey
        })
        .rpc();
    } catch (_err) {
      rejected = true;
    }

    assert.isTrue(rejected, "withdrawing more than the vault balance should have been rejected");
  });

  it("keeps two owners' vaults fully independent", async () => {
    const { owner: ownerA, program: programA } = await newFundedOwner(2);
    const { owner: ownerB, program: programB } = await newFundedOwner(2);
    const vaultA = vaultPdaFor(ownerA.publicKey, programA.programId);
    const vaultB = vaultPdaFor(ownerB.publicKey, programB.programId);

    await programA.methods
      .initialize()
      .accounts({ owner: ownerA.publicKey })
      .rpc();
    await programB.methods
      .initialize()
      .accounts({ owner: ownerB.publicKey })
      .rpc();

    const depositA = 0.4 * LAMPORTS_PER_SOL;
    const depositB = 0.7 * LAMPORTS_PER_SOL;
    await programA.methods
      .deposit(new BN(depositA))
      .accounts({ depositor: ownerA.publicKey, owner: ownerA.publicKey })
      .rpc();
    await programB.methods
      .deposit(new BN(depositB))
      .accounts({ depositor: ownerB.publicKey, owner: ownerB.publicKey })
      .rpc();

    const vaultBBalanceBeforeWithdrawA = await baseProvider.connection.getBalance(vaultB);

    await programA.methods
      .withdraw(new BN(0.1 * LAMPORTS_PER_SOL))
      .accounts({ owner: ownerA.publicKey })
      .rpc();

    const vaultBBalanceAfterWithdrawA = await baseProvider.connection.getBalance(vaultB);
    assert.equal(
      vaultBBalanceAfterWithdrawA,
      vaultBBalanceBeforeWithdrawA,
      "owner B's vault balance must be untouched by owner A's withdrawal"
    );

    // And owner B's own withdrawal only ever touches vault B.
    const vaultABalanceBeforeWithdrawB = await baseProvider.connection.getBalance(vaultA);
    await programB.methods
      .withdraw(new BN(0.2 * LAMPORTS_PER_SOL))
      .accounts({ owner: ownerB.publicKey })
      .rpc();
    const vaultABalanceAfterWithdrawB = await baseProvider.connection.getBalance(vaultA);
    assert.equal(
      vaultABalanceAfterWithdrawB,
      vaultABalanceBeforeWithdrawB,
      "owner A's vault balance must be untouched by owner B's withdrawal"
    );
  });

  it("rejects initializing the same vault a second time", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey })
      .rpc();

    let rejected = false;
    try {
      await program.methods
        .initialize()
        .accounts({ owner: owner.publicKey })
        .rpc();
    } catch (_err) {
      rejected = true;
    }

    assert.isTrue(rejected, "initializing an already-existing vault a second time should have been rejected");
  });

  it("accumulates multiple sequential deposits", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey })
      .rpc();

    const balanceBefore = await baseProvider.connection.getBalance(vaultPda);
    const deposits = [0.1 * LAMPORTS_PER_SOL, 0.05 * LAMPORTS_PER_SOL, 0.25 * LAMPORTS_PER_SOL];

    for (const depositAmount of deposits) {
      await program.methods
        .deposit(new BN(depositAmount))
        .accounts({ depositor: owner.publicKey, owner: owner.publicKey })
        .rpc();
    }

    const balanceAfter = await baseProvider.connection.getBalance(vaultPda);
    const totalDeposited = deposits.reduce((sum, amount) => sum + amount, 0);
    assert.equal(balanceAfter - balanceBefore, totalDeposited);
  });

  it("lets a depositor who is not the vault's owner fund it", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey })
      .rpc();

    const { owner: depositor, program: depositorProgram } = await newFundedOwner(1);
    const balanceBefore = await baseProvider.connection.getBalance(vaultPda);
    const depositAmount = 0.15 * LAMPORTS_PER_SOL;

    await depositorProgram.methods
      .deposit(new BN(depositAmount))
      .accounts({
        depositor: depositor.publicKey,
        owner: owner.publicKey
      })
      .rpc();

    const balanceAfter = await baseProvider.connection.getBalance(vaultPda);
    assert.equal(balanceAfter - balanceBefore, depositAmount);
  });

  it("treats a zero-amount deposit as a successful no-op", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey })
      .rpc();

    const balanceBefore = await baseProvider.connection.getBalance(vaultPda);

    await program.methods
      .deposit(new BN(0))
      .accounts({ depositor: owner.publicKey, owner: owner.publicKey })
      .rpc();

    const balanceAfter = await baseProvider.connection.getBalance(vaultPda);
    assert.equal(balanceAfter, balanceBefore, "a zero-lamport transfer is accepted by the System Program and moves nothing");
  });

  it("treats a zero-amount withdrawal as a successful no-op", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey })
      .rpc();

    const depositAmount = 0.2 * LAMPORTS_PER_SOL;
    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({ depositor: owner.publicKey, owner: owner.publicKey })
      .rpc();

    const balanceBefore = await baseProvider.connection.getBalance(vaultPda);

    await program.methods
      .withdraw(new BN(0))
      .accounts({ owner: owner.publicKey })
      .rpc();

    const balanceAfter = await baseProvider.connection.getBalance(vaultPda);
    assert.equal(balanceAfter, balanceBefore, "a zero-amount withdrawal passes the balance check trivially and moves nothing");
  });

  it("draining the vault for its exact full balance removes the account from the ledger", async () => {
    const { owner, program } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey })
      .rpc();

    const depositAmount = 0.3 * LAMPORTS_PER_SOL;
    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({ depositor: owner.publicKey, owner: owner.publicKey })
      .rpc();

    const fullBalance = await baseProvider.connection.getBalance(vaultPda);

    await program.methods
      .withdraw(new BN(fullBalance))
      .accounts({ owner: owner.publicKey })
      .rpc();

    const vaultAccount = await baseProvider.connection.getAccountInfo(vaultPda);
    assert.isNull(
      vaultAccount,
      "an account drained to zero lamports is purged by the runtime rather than left behind at zero"
    );
  });

  it("rejects a withdrawal whose system_program account is not the real System Program", async () => {
    // Anchor's TS client auto-resolves `system_program` to the real System
    // Program address from the IDL's fixed-address hint, silently overriding
    // whatever we pass through `.accounts()` (or `.instruction()`). To prove
    // the on-chain program itself - not just the generated client - rejects
    // a forged system program, the instruction is built normally and then
    // the account key is swapped by hand before sending, the way a hand-rolled
    // (non-Anchor-client) attacker transaction would.
    const { owner, program, provider } = await newFundedOwner(2);
    const vaultPda = vaultPdaFor(owner.publicKey, program.programId);

    await program.methods
      .initialize()
      .accounts({ owner: owner.publicKey })
      .rpc();

    const depositAmount = 0.2 * LAMPORTS_PER_SOL;
    await program.methods
      .deposit(new BN(depositAmount))
      .accounts({ depositor: owner.publicKey, owner: owner.publicKey })
      .rpc();

    const ix = await program.methods
      .withdraw(new BN(1_000))
      .accounts({ owner: owner.publicKey })
      .instruction();

    const systemProgramIndex = ix.keys.findIndex((key) => key.pubkey.equals(SystemProgram.programId));
    assert.notEqual(systemProgramIndex, -1, "expected the instruction to reference the System Program");
    ix.keys[systemProgramIndex] = { ...ix.keys[systemProgramIndex], pubkey: program.programId };

    const tx = new anchor.web3.Transaction().add(ix);

    let rejected = false;
    try {
      await provider.sendAndConfirm(tx);
    } catch (_err) {
      rejected = true;
    }

    assert.isTrue(
      rejected,
      "a hand-crafted instruction pointing 'system_program' at a forged program should have been rejected"
    );
  });
});
