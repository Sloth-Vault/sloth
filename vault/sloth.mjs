// SLOTH vault core. Works in Node and in the browser bundle.
// A vault is a Squads v4 multisig: 2 of 3 keys, one time lock, no config authority.
import * as multisig from '@sqds/multisig';
import {
  ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const { Permission, Permissions } = multisig.types;
const { accounts, instructions, generated } = multisig;

export const THRESHOLD = 2;
export const TIME_LOCKS = { '24 hours': 86400, '3 days': 259200, '7 days': 604800 };
export const MAX_TX_BYTES = 1232;
export const SOL_RENT_FLOOR = 890880n;
const PRIORITY_MICROLAMPORTS = 50000;
const COMPUTE_LIMIT = 400000;
const HISTORY = 24;

export const fullAccess = () => Permissions.all();
export const voteOnly = () => Permissions.fromPermissions([Permission.Vote]);
const key = (k) => (k instanceof PublicKey ? k : new PublicKey(k));

export function vaultOf(multisigPda) {
  return multisig.getVaultPda({ multisigPda: key(multisigPda), index: 0 })[0];
}

// Main and backup can do everything. The guardian only votes, so it can never start a move.
export async function buildCreate({ connection, creator, backup, guardian, timeLock, anyWait = false }) {
  const keys = [creator, backup, guardian].map((k) => key(k).toBase58());
  if (new Set(keys).size !== 3) throw new Error('Main, backup and guardian must be three different wallets');
  if (!anyWait && !Object.values(TIME_LOCKS).includes(timeLock)) throw new Error('Pick one of the listed waits');
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [configPda] = multisig.getProgramConfigPda({});
  const config = await accounts.ProgramConfig.fromAccountAddress(connection, configPda);
  const ix = instructions.multisigCreateV2({
    treasury: config.treasury,
    creator: key(creator),
    multisigPda,
    configAuthority: null,
    threshold: THRESHOLD,
    members: [
      { key: key(creator), permissions: fullAccess() },
      { key: key(backup), permissions: fullAccess() },
      { key: key(guardian), permissions: voteOnly() },
    ],
    timeLock,
    createKey: createKey.publicKey,
    rentCollector: vaultOf(multisigPda),
    memo: 'SLOTH vault',
  });
  return { createKey, multisigPda, vault: vaultOf(multisigPda), ixs: [ix] };
}

async function nextIndex(connection, multisigPda) {
  const ms = await accounts.Multisig.fromAccountAddress(connection, multisigPda);
  return BigInt(ms.transactionIndex.toString()) + 1n;
}

async function tokenProgramOf(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error('Mint not found');
  if (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) return info.owner;
  throw new Error('Not a token mint');
}

export function solInstruction(vault, to, lamports) {
  return SystemProgram.transfer({ fromPubkey: vault, toPubkey: to, lamports });
}

// Wraps the move, opens the proposal and casts the proposer's vote.
function proposeIxs({ multisigPda, index, member, createIx }) {
  return [
    createIx,
    instructions.proposalCreate({ multisigPda, transactionIndex: index, creator: member }),
    instructions.proposalApprove({ multisigPda, transactionIndex: index, member }),
  ];
}

export async function buildWithdraw({ connection, multisigPda, member, to, amount, mint, decimals }) {
  multisigPda = key(multisigPda); member = key(member); to = key(to);
  const vault = vaultOf(multisigPda);
  const index = await nextIndex(connection, multisigPda);
  const setup = [];
  let inner;
  if (mint) {
    mint = key(mint);
    const program = await tokenProgramOf(connection, mint);
    const src = getAssociatedTokenAddressSync(mint, vault, true, program);
    const dst = getAssociatedTokenAddressSync(mint, to, true, program);
    setup.push(createAssociatedTokenAccountIdempotentInstruction(member, dst, to, mint, program));
    inner = createTransferCheckedInstruction(src, mint, dst, vault, amount, decimals, [], program);
  } else {
    const balance = BigInt(await connection.getBalance(vault));
    const left = balance - BigInt(amount);
    if (left < 0n) throw new Error('More than the vault holds');
    if (left > 0n && left < SOL_RENT_FLOOR) throw new Error('Take all of it, or leave at least 0.00089 SOL');
    inner = solInstruction(vault, to, amount);
  }
  const { blockhash } = await connection.getLatestBlockhash();
  const createIx = instructions.vaultTransactionCreate({
    multisigPda, transactionIndex: index, creator: member, vaultIndex: 0, ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: [inner] }),
    memo: 'SLOTH withdrawal',
  });
  return { index, ixs: [...setup, ...proposeIxs({ multisigPda, index, member, createIx })] };
}

// Swaps one key for another with the same rights. It waits out the time lock like any move.
export async function buildRotate({ connection, multisigPda, member, oldKey, newKey }) {
  multisigPda = key(multisigPda); member = key(member); oldKey = key(oldKey); newKey = key(newKey);
  const ms = await accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const old = ms.members.find((m) => m.key.equals(oldKey));
  if (!old) throw new Error('That key is not on this vault');
  if (ms.members.some((m) => m.key.equals(newKey))) throw new Error('That key is already on this vault');
  const index = BigInt(ms.transactionIndex.toString()) + 1n;
  const createIx = instructions.configTransactionCreate({
    multisigPda, transactionIndex: index, creator: member,
    actions: [
      { __kind: 'AddMember', newMember: { key: newKey, permissions: old.permissions } },
      { __kind: 'RemoveMember', oldMember: oldKey },
    ],
    memo: 'SLOTH key change',
  });
  return { index, ixs: proposeIxs({ multisigPda, index, member, createIx }) };
}

export function buildApprove({ multisigPda, member, index }) {
  return [instructions.proposalApprove({ multisigPda: key(multisigPda), transactionIndex: BigInt(index), member: key(member) })];
}
export function buildReject({ multisigPda, member, index }) {
  return [instructions.proposalReject({ multisigPda: key(multisigPda), transactionIndex: BigInt(index), member: key(member) })];
}
export function buildCancel({ multisigPda, member, index }) {
  return [instructions.proposalCancelV2({ multisigPda: key(multisigPda), transactionIndex: BigInt(index), member: key(member) })];
}
export async function buildRelease({ connection, multisigPda, member, index, kind }) {
  const args = { multisigPda: key(multisigPda), transactionIndex: BigInt(index), member: key(member) };
  if (kind === 'config') return { ixs: [instructions.configTransactionExecute({ ...args, rentPayer: key(member) })], tables: [] };
  const { instruction, lookupTableAccounts } = await instructions.vaultTransactionExecute({ connection, ...args });
  return { ixs: [instruction], tables: lookupTableAccounts };
}

export function txSize(payer, blockhash, ixs, tables = []) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: withBudget(ixs) }).compileToV0Message(tables);
  return { message, bytes: 1 + 64 * message.header.numRequiredSignatures + message.serialize().length };
}

function withBudget(ixs) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
    ...ixs,
  ];
}

// Moves too large for one transaction get split between instructions.
export function pack(payer, blockhash, ixs, tables = []) {
  const groups = [];
  let group = [];
  for (const ix of ixs) {
    if (group.length && txSize(payer, blockhash, [...group, ix], tables).bytes > MAX_TX_BYTES) {
      groups.push(group);
      group = [];
    }
    group.push(ix);
  }
  if (group.length) groups.push(group);
  return groups.map((g) => new VersionedTransaction(txSize(payer, blockhash, g, tables).message));
}

const u32 = (buf, at) => buf.readUInt32LE(at);
const u64 = (buf, at) => buf.readBigUInt64LE(at);

// Reads a move from chain bytes. Anything but one plain transfer comes back as unknown.
export function decodeVaultMove(tx) {
  const { accountKeys, instructions: ixs } = tx.message;
  const known = ixs.length === 1;
  const ix = ixs[0];
  if (!known || !ix) return { kind: 'unknown' };
  const program = accountKeys[ix.programIdIndex];
  const data = Buffer.from(ix.data);
  const at = (i) => accountKeys[ix.accountIndexes[i]];
  if (program.equals(SystemProgram.programId) && data.length === 12 && u32(data, 0) === 2) {
    return { kind: 'sol', from: at(0), to: at(1), lamports: u64(data, 4) };
  }
  if ((program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) && data[0] === 12 && data.length === 10) {
    return { kind: 'token', from: at(0), mint: at(1), toAccount: at(2), amount: u64(data, 1), decimals: data[9] };
  }
  return { kind: 'unknown' };
}

export function decodeConfigMove(tx) {
  const actions = tx.actions;
  const add = actions.find((a) => a.__kind === 'AddMember');
  const remove = actions.find((a) => a.__kind === 'RemoveMember');
  if (actions.length === 2 && add && remove) {
    return { kind: 'rotate', oldKey: remove.oldMember, newKey: add.newMember.key };
  }
  return { kind: 'unknown', actions: actions.map((a) => a.__kind) };
}

export function roleOf(member) {
  return Permissions.has(member.permissions, Permission.Initiate) ? 'full' : 'vote';
}

function statusOf(proposal, timeLock) {
  const kind = proposal.status.__kind;
  const at = Number(proposal.status.timestamp?.toString() ?? 0);
  return { status: kind, at, releaseAt: kind === 'Approved' ? at + timeLock : null };
}

export function deserializeRequest({ index, proposalInfo, txInfo, timeLock, stale }) {
  let move = { kind: 'unknown' };
  let type = 'unknown';
  if (txInfo) {
    try {
      move = decodeVaultMove(accounts.VaultTransaction.fromAccountInfo(txInfo)[0]);
      type = 'vault';
    } catch {
      try {
        move = decodeConfigMove(accounts.ConfigTransaction.fromAccountInfo(txInfo)[0]);
        type = 'config';
      } catch { /* an account type this site does not know stays unknown */ }
    }
  }
  const proposal = proposalInfo ? accounts.Proposal.fromAccountInfo(proposalInfo)[0] : null;
  return {
    index, type, move, stale: index <= stale,
    approved: proposal?.approved.map(String) ?? [],
    rejected: proposal?.rejected.map(String) ?? [],
    cancelled: proposal?.cancelled.map(String) ?? [],
    ...(proposal ? statusOf(proposal, timeLock) : { status: 'NoProposal', at: 0, releaseAt: null }),
  };
}

export async function readVault(connection, multisigPda) {
  multisigPda = key(multisigPda);
  const ms = await accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const vault = vaultOf(multisigPda);
  const last = Number(ms.transactionIndex.toString());
  const stale = Number(ms.staleTransactionIndex.toString());
  const indexes = [];
  for (let i = last; i >= 1 && indexes.length < HISTORY; i--) indexes.push(i);
  const pdas = indexes.flatMap((i) => [
    multisig.getProposalPda({ multisigPda, transactionIndex: BigInt(i) })[0],
    multisig.getTransactionPda({ multisigPda, index: BigInt(i) })[0],
  ]);
  const infos = [];
  for (let i = 0; i < pdas.length; i += 100) infos.push(...await connection.getMultipleAccountsInfo(pdas.slice(i, i + 100)));
  const requests = indexes.map((index, n) => deserializeRequest({
    index, proposalInfo: infos[n * 2], txInfo: infos[n * 2 + 1], timeLock: ms.timeLock, stale,
  }));
  await fillTokenOwners(connection, requests);
  const [lamports, tokens] = await Promise.all([connection.getBalance(vault), readTokens(connection, vault)]);
  return {
    multisigPda, vault, lamports, tokens, requests, stale, last,
    threshold: ms.threshold,
    timeLock: ms.timeLock,
    members: ms.members.map((m) => ({ key: m.key.toBase58(), role: roleOf(m) })),
  };
}

// A token move names a token account; voters need to see the wallet behind it.
async function fillTokenOwners(connection, requests) {
  const moves = requests.map((r) => r.move).filter((m) => m.kind === 'token');
  if (!moves.length) return;
  const infos = await connection.getMultipleAccountsInfo(moves.slice(0, 100).map((m) => m.toAccount));
  infos.forEach((info, i) => {
    moves[i].to = info && info.data.length >= 64 ? new PublicKey(info.data.subarray(32, 64)) : null;
  });
}

async function readTokens(connection, owner) {
  const lists = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
    connection.getParsedTokenAccountsByOwner(owner, { programId })));
  return lists.flatMap((r) => r.value).map(({ pubkey, account }) => {
    const { mint, tokenAmount } = account.data.parsed.info;
    return { account: pubkey.toBase58(), mint, amount: tokenAmount.amount, decimals: tokenAmount.decimals, ui: tokenAmount.uiAmountString };
  }).filter((t) => t.amount !== '0');
}

// Walks the list once and reports what a key may do with a request right now.
export function actionsFor(request, wallet, member, now) {
  const out = { approve: false, reject: false, cancel: false, release: false };
  if (!member) return out;
  const voted = (list) => list.includes(wallet);
  const fresh = !request.stale;
  if (request.status === 'Active' && fresh) {
    out.approve = !voted(request.approved);
    out.reject = !voted(request.rejected) && !voted(request.approved);
  }
  if (request.status === 'Approved') {
    out.cancel = !voted(request.cancelled);
    const configBlocked = request.type === 'config' && request.stale;
    out.release = member.role === 'full' && now >= request.releaseAt && !configBlocked;
  }
  return out;
}

export function solAmount(text) {
  const clean = String(text).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(clean)) throw new Error('Enter an amount like 1.25');
  const [whole, part = ''] = clean.split('.');
  const lamports = BigInt(whole) * BigInt(LAMPORTS_PER_SOL) + BigInt(part.padEnd(9, '0'));
  if (lamports === 0n) throw new Error('Enter an amount above zero');
  return lamports;
}

export function tokenAmount(text, decimals) {
  const clean = String(text).trim();
  const [whole, part = ''] = clean.split('.');
  if (!/^\d+(\.\d+)?$/.test(clean) || part.length > decimals) throw new Error('Too many decimals for this token');
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(part.padEnd(decimals, '0') || 0);
  if (raw === 0n) throw new Error('Enter an amount above zero');
  return raw;
}

export { ASSOCIATED_TOKEN_PROGRAM_ID, generated, multisig };
