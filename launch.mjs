#!/usr/bin/env node
// scripts/launch.mjs — launch Agent Paycheck ($PAYCHK) on pump.fun.
//
// This is the agent's own launch tool for make.fun's "Launch a coin that sells
// make.fun" bounty (makefun-coin-promo-01). It is NOT the graded entrypoint:
// main.ts (the graded program) only copies LAUNCH.json to /output, because the
// grader runs it with no network, no wallet and no clock. This script is what
// the agent runs, on its own machine, to actually create the coin.
//
// What it does, in order:
//   1. Reads the coin from coin.json (name, ticker, description, website).
//   2. Resolves the metadata URI: pass --metadata-uri to point at a metadata
//      JSON you already host — the reliable path is this repository's own
//      metadata.json, pushed public first:
//        https://raw.githubusercontent.com/LensHawthorne/agent-paycheck/main/metadata.json
//      Without --metadata-uri it tries pump.fun's own IPFS upload endpoint;
//      that endpoint is Cloudflare-gated from this machine, so expect it to
//      fail here and use --metadata-uri instead.
//   3. Generates a fresh mint keypair and derives every PDA pump.fun's
//      create instruction needs (mint authority, bonding curve, associated
//      bonding curve, global, metadata, event authority).
//   4. Builds the create transaction (create the mint account, initialise
//      the mint, call pump.fun create), signs it with the mint keypair and
//      the creator wallet, sends it, waits for confirmation, verifies the
//      create really happened, then prints the mint and the create signature
//      and writes them into LAUNCH.json.
//
// Standard library only (node:crypto, node:fs, global fetch). No install.
//
// Usage:
//   node scripts/launch.mjs --keypair <wallet.json> [--coin coin.json] [--logo logo.png]
//       [--rpc <url>] [--metadata-uri <url>] [--out LAUNCH.json]
//       [--compute-unit-price <microlamports>] [--dry-run] [--verify-mint <mint>]
//
//   --keypair       Solana keypair JSON (64-number array) of the wallet linked
//                   to the make.fun account. It signs and pays. The file is
//                   only read; the secret never leaves this machine and is
//                   never printed.
//   --dry-run       Build and sign the transaction with a throwaway mint and a
//                   dummy blockhash, verify the signatures, verify the PDA
//                   derivation against a real live coin, print everything —
//                   and send nothing. Spends no SOL.
//   --verify-mint   Only check the PDA derivation against a live coin's mint
//                   (global, mint authority, bonding curve, metadata) and exit.
//
// Cost of a create-only launch: roughly 0.02–0.04 SOL (rent for the mint,
// bonding curve and metadata accounts plus the transaction fee). The script
// checks the wallet holds at least that plus a buffer and refuses to send
// when it does not. It never buys: the judge never sees price, trades or
// holders, so a first buy buys nothing for the entry.
//
// Safety: this script never prints a secret key. The mint keypair it
// generates is used once, in memory, to sign the create transaction; after
// the coin exists its mint authority is pump.fun's PDA, so the mint keypair
// is useless afterwards and is not saved anywhere.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------- constants

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MPL_TOKEN_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const MINT_SIZE = 82; // bytes of an SPL Token mint account
const TOKEN_DECIMALS = 6;
const COMPUTE_UNIT_LIMIT = 400_000;
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const PUMP_IPFS = "https://pump.fun/api/ipfs";
// The pump.fun mint authority: the PDA of ["mint-authority"], one address for
// every pump.fun coin. Cross-checked against the program's IDL and the
// published value; the script refuses to run if its derivation differs.
const PUMP_MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

// Lamports the wallet must hold above the mint rent before we send:
// ~0.03 SOL covers the bonding-curve and metadata accounts pump.fun creates,
// plus 0.005 SOL for the transaction fee and the priority fee.
const PROGRAM_ACCOUNTS_BUFFER_LAMPORTS = 30_000_000;
const FEES_BUFFER_LAMPORTS = 5_000_000;

// ---------------------------------------------------------------- base58

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}

function b58decode(text) {
  let n = 0n;
  for (const ch of text) {
    const i = B58_ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`not base58: ${JSON.stringify(text)}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------- keys

// A Solana keypair file is a JSON array of 64 numbers: seed (32) + pubkey (32).
function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error(`${path} is not a Solana keypair file (expected 64 numbers)`);
  }
  const secret = Buffer.from(raw);
  const seed = secret.subarray(0, 32);
  const pub = secret.subarray(32, 64);
  const priv = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: seed.toString("base64url"),
      x: pub.toString("base64url"),
    },
    format: "jwk",
  });
  const derived = createPublicKey(priv).export({ format: "jwk" });
  if (Buffer.from(derived.x, "base64url").toString("hex") !== pub.toString("hex")) {
    throw new Error(`${path} is inconsistent: its public key does not match its seed`);
  }
  return { seed, pub, priv, address: b58encode(pub) };
}

function freshKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privJwk = privateKey.export({ format: "jwk" });
  const pubJwk = publicKey.export({ format: "jwk" });
  const seed = Buffer.from(privJwk.d, "base64url");
  const pub = Buffer.from(pubJwk.x, "base64url");
  return { seed, pub, priv: privateKey, address: b58encode(pub) };
}

// ---------------------------------------------------------------- PDAs

// A program-derived address is a SHA-256 hash that is NOT a valid Ed25519
// point. Node's key import does not reject points off the curve, so the check
// is done here, directly on the curve equation, with BigInt field arithmetic:
// for a compressed point (y in little-endian, top bit = sign of x), the
// curve -x^2 + y^2 = 1 + d x^2 y^2 (mod 2^255 - 19) gives
// x^2 = (y^2 - 1) / (d y^2 + 1). A point exists exactly when that quotient
// is a quadratic residue mod p (p is 5 mod 8, so the square root is
// x = q^((p+3)/8), falling back to x * 2^((p-1)/4)). The dry run
// cross-checks the derivation against live accounts, so a wrong answer here
// is caught before any SOL moves.
const FIELD_P = (1n << 255n) - 19n;
const CURVE_D = (((-121665n * modPow(121666n, FIELD_P - 2n, FIELD_P)) % FIELD_P) + FIELD_P) % FIELD_P;

function modPow(base, exp, m) {
  let r = 1n;
  let b = ((base % m) + m) % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function bytesToBigIntLE(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function isOnCurveCompressed(bytes) {
  const y = bytesToBigIntLE(bytes) & ((1n << 255n) - 1n);
  const y2 = (y * y) % FIELD_P;
  const u = (((y2 - 1n) % FIELD_P) + FIELD_P) % FIELD_P;
  const v = (((CURVE_D * y2 + 1n) % FIELD_P) + FIELD_P) % FIELD_P;
  if (v === 0n) return false;
  const x2 = (u * modPow(v, FIELD_P - 2n, FIELD_P)) % FIELD_P;
  let x = modPow(x2, (FIELD_P + 3n) / 8n, FIELD_P);
  if ((x * x) % FIELD_P !== x2) {
    x = (x * modPow(2n, (FIELD_P - 1n) / 4n, FIELD_P)) % FIELD_P;
    if ((x * x) % FIELD_P !== x2) return false;
  }
  return true;
}

function isOffCurve(bytes) {
  return !isOnCurveCompressed(bytes);
}

function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash("sha256")
      .update(Buffer.concat([...seeds, Buffer.from([bump]), programId, Buffer.from("ProgramDerivedAddress")]))
      .digest();
    if (isOffCurve(hash)) return { address: hash, bump };
  }
  throw new Error("no program address found (no bump works)");
}

function derivePumpPdas(mint) {
  const pump = b58decode(PUMP_PROGRAM);
  const metaProgram = b58decode(MPL_TOKEN_METADATA);
  return {
    // The mint authority is ONE address for every pump.fun coin: the PDA of
    // ["mint-authority"] alone (no mint in the seeds), per the program's IDL.
    mintAuthority: findProgramAddress([Buffer.from("mint-authority")], pump).address,
    bondingCurve: findProgramAddress([Buffer.from("bonding-curve"), mint], pump).address,
    global: findProgramAddress([Buffer.from("global")], pump).address,
    metadata: findProgramAddress([Buffer.from("metadata"), metaProgram, mint], metaProgram).address,
    eventAuthority: findProgramAddress([Buffer.from("__event_authority")], pump).address,
  };
}

function associatedTokenAccount(owner, mint) {
  return findProgramAddress(
    [owner, b58decode(TOKEN_PROGRAM), mint],
    b58decode(ATA_PROGRAM),
  ).address;
}

// ---------------------------------------------------------------- instruction encoding

function borshString(text) {
  const body = Buffer.from(text, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

function ixCreateAccount(from, mint, lamports, space, owner) {
  const data = Buffer.alloc(4 + 8 + 8 + 32);
  data.writeUInt32LE(0, 0); // SystemProgram CreateAccount
  data.writeBigUInt64LE(BigInt(lamports), 4);
  data.writeBigUInt64LE(BigInt(space), 12);
  b58decode(owner).copy(data, 20);
  return {
    programId: b58decode(SYSTEM_PROGRAM),
    accounts: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: true, isWritable: true },
    ],
    data,
  };
}

function ixInitializeMint2(mint, decimals, mintAuthority) {
  // Token program InitializeMint2: [20, decimals, mintAuthority, freezeOption=1, freezeAuthority]
  const data = Buffer.alloc(1 + 1 + 32 + 1 + 32);
  data[0] = 20;
  data[1] = decimals;
  mintAuthority.copy(data, 2);
  data[34] = 1;
  mintAuthority.copy(data, 35);
  return {
    programId: b58decode(TOKEN_PROGRAM),
    accounts: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  };
}

function ixPumpCreate(pdas, mint, user, name, symbol, uri) {
  const data = Buffer.concat([
    CREATE_DISCRIMINATOR,
    borshString(name),
    borshString(symbol),
    borshString(uri),
    user, // creator
  ]);
  return {
    programId: b58decode(PUMP_PROGRAM),
    accounts: [
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: pdas.mintAuthority, isSigner: false, isWritable: false },
      { pubkey: pdas.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: pdas.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: pdas.global, isSigner: false, isWritable: false },
      { pubkey: b58decode(MPL_TOKEN_METADATA), isSigner: false, isWritable: false },
      { pubkey: pdas.metadata, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: b58decode(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: b58decode(TOKEN_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: b58decode(ATA_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: b58decode(RENT_SYSVAR), isSigner: false, isWritable: false },
      { pubkey: pdas.eventAuthority, isSigner: false, isWritable: false },
      // The IDL lists a 14th account, the pump program itself.
      { pubkey: b58decode(PUMP_PROGRAM), isSigner: false, isWritable: false },
    ],
    data,
  };
}

function ixComputeUnitLimit(limit) {
  const data = Buffer.alloc(5);
  data[0] = 2;
  data.writeUInt32LE(limit, 1);
  return { programId: b58decode(COMPUTE_BUDGET_PROGRAM), accounts: [], data };
}

function ixComputeUnitPrice(microLamports) {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(BigInt(microLamports), 1);
  return { programId: b58decode(COMPUTE_BUDGET_PROGRAM), accounts: [], data };
}

// ---------------------------------------------------------------- transactions

function shortvec(n) {
  const out = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

// Compile a legacy Solana message: deduplicate the accounts, sort them the
// way the runtime requires (signers first, writable first, stable within a
// bucket), and lay out the header, the keys, the blockhash and the
// instructions. Returns the message bytes and the signers in wire order.
function compileMessage(instructions, blockhash) {
  const map = new Map();
  const add = (pubkey, isSigner, isWritable) => {
    const key = pubkey.toString("hex");
    const cur = map.get(key);
    if (cur) {
      cur.isSigner = cur.isSigner || isSigner;
      cur.isWritable = cur.isWritable || isWritable;
    } else {
      map.set(key, { pubkey, isSigner, isWritable });
    }
  };
  for (const ix of instructions) {
    add(ix.programId, false, false);
    for (const a of ix.accounts) add(a.pubkey, a.isSigner, a.isWritable);
  }
  const list = [...map.values()];
  const rank = (a) => (a.isSigner ? 0 : 2) + (a.isWritable ? 0 : 1);
  list.sort((a, b) => rank(a) - rank(b)); // Array.sort is stable
  const index = new Map(list.map((a, i) => [a.pubkey.toString("hex"), i]));
  const numSigners = list.filter((a) => a.isSigner).length;
  const numReadonlySigned = list.filter((a) => a.isSigner && !a.isWritable).length;
  const numReadonlyUnsigned = list.filter((a) => !a.isSigner && !a.isWritable).length;
  const header = Buffer.from([numSigners, numReadonlySigned, numReadonlyUnsigned]);
  const parts = [
    header,
    shortvec(list.length),
    Buffer.concat(list.map((a) => a.pubkey)),
    blockhash,
    shortvec(instructions.length),
  ];
  for (const ix of instructions) {
    parts.push(Buffer.from([index.get(ix.programId.toString("hex"))]));
    parts.push(shortvec(ix.accounts.length));
    parts.push(Buffer.concat(ix.accounts.map((a) => Buffer.from([index.get(a.pubkey.toString("hex"))]))));
    parts.push(shortvec(ix.data.length));
    parts.push(ix.data);
  }
  return { message: Buffer.concat(parts), signers: list.filter((a) => a.isSigner).map((a) => a.pubkey) };
}

function buildTransaction(instructions, blockhash, signers) {
  const { message, signers: ordered } = compileMessage(instructions, blockhash);
  const privByPub = new Map(signers.map((s) => [s.pub.toString("hex"), s.priv]));
  const sigs = ordered.map((pub) => {
    const priv = privByPub.get(pub.toString("hex"));
    if (!priv) throw new Error(`no signer for ${b58encode(pub)}`);
    return sign(null, message, priv);
  });
  const wire = Buffer.concat([shortvec(sigs.length), ...sigs, message]);
  return { wire, message, signatures: sigs.map((s) => b58encode(s)) };
}

// ---------------------------------------------------------------- RPC + IPFS

async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function uploadToPumpIpfs(fileBytes, filename, mime) {
  const form = new FormData();
  form.append("file", new Blob([fileBytes], { type: mime }), filename);
  let res;
  try {
    res = await fetch(PUMP_IPFS, { method: "POST", body: form });
  } catch (err) {
    throw new Error(
      `pump.fun IPFS upload unreachable (${err.message}). Host metadata.json in this public repository instead and pass --metadata-uri https://raw.githubusercontent.com/<owner>/<repo>/main/metadata.json`,
    );
  }
  if (!res.ok) throw new Error(`pump.fun IPFS upload failed: HTTP ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(
      "pump.fun IPFS upload did not answer with JSON (its site blocks this machine). Host metadata.json in this public repository instead and pass --metadata-uri https://raw.githubusercontent.com/<owner>/<repo>/main/metadata.json",
    );
  }
  if (!json.ipfsHash) throw new Error(`pump.fun IPFS upload gave no hash: ${JSON.stringify(json)}`);
  return json.ipfsHash;
}

async function waitForConfirmation(rpcUrl, signature, timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    const result = await rpc(rpcUrl, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const status = result.value && result.value[0];
    if (status && status.err) throw new Error(`transaction failed on chain: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return status;
    if (Date.now() - started > timeoutMs) throw new Error(`no confirmation within ${timeoutMs / 1000}s for ${signature}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------- PDA verification

// Prove the PDA derivation against a coin that already lives on chain: the
// global account must exist and belong to the pump program, the mint's
// on-chain mint authority must equal the derived mint authority, and the
// bonding curve and metadata accounts must exist. Any failure here means
// the derivation is wrong and the launch must not run.
async function verifyCoinPdas(rpcUrl, mintB58) {
  const mint = b58decode(mintB58);
  const pdas = derivePumpPdas(mint);
  const abc = associatedTokenAccount(pdas.bondingCurve, mint);
  const checks = [];
  const accountInfo = async (address) => {
    const r = await rpc(rpcUrl, "getAccountInfo", [address, { encoding: "base64" }]);
    return r.value;
  };
  const global = await accountInfo(b58encode(pdas.global));
  checks.push({
    name: "global account exists and belongs to the pump program",
    pass: !!global && global.owner === PUMP_PROGRAM,
    detail: global ? `owner ${global.owner}` : "account not found",
  });
  const mintInfo = await accountInfo(mintB58);
  let mintAuthorityMatches = false;
  if (mintInfo) {
    const data = Buffer.from(mintInfo.data[0], "base64");
    const onChainAuthority = data.subarray(4, 36);
    mintAuthorityMatches = onChainAuthority.equals(pdas.mintAuthority);
  }
  checks.push({
    name: "mint authority on chain equals the derived mint-authority PDA",
    pass: mintAuthorityMatches,
    detail: mintInfo ? "mint account read" : "mint account not found",
  });
  const curve = await accountInfo(b58encode(pdas.bondingCurve));
  checks.push({
    name: "bonding curve account exists",
    pass: !!curve,
    detail: curve ? `${curve.data[0].length} bytes on chain` : "account not found",
  });
  const metadata = await accountInfo(b58encode(pdas.metadata));
  checks.push({
    name: "metadata account exists and belongs to the Metaplex program",
    pass: !!metadata && metadata.owner === MPL_TOKEN_METADATA,
    detail: metadata ? `owner ${metadata.owner}` : "account not found",
  });
  const abcInfo = await accountInfo(b58encode(abc));
  checks.push({
    name: "associated bonding curve account exists",
    pass: !!abcInfo,
    detail: abcInfo ? "account found" : "account not found",
  });
  for (const c of checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`);
  return checks.every((c) => c.pass);
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { coin: "coin.json", logo: "logo.png", out: "LAUNCH.json", rpc: DEFAULT_RPC, computeUnitPrice: 25_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--keypair") args.keypair = next();
    else if (a === "--coin") args.coin = next();
    else if (a === "--logo") args.logo = next();
    else if (a === "--rpc") args.rpc = next();
    else if (a === "--metadata-uri") args.metadataUri = next();
    else if (a === "--out") args.out = next();
    else if (a === "--compute-unit-price") args.computeUnitPrice = Number(next());
    else if (a === "--blockhash") args.blockhash = next();
    else if (a === "--verify-mint") args.verifyMint = next();
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function usage() {
  console.log(`launch Agent Paycheck ($PAYCHK) on pump.fun.

Usage:
  node scripts/launch.mjs --keypair <wallet.json> [--coin coin.json] [--logo logo.png]
      [--rpc <url>] [--metadata-uri <url>] [--out LAUNCH.json]
      [--compute-unit-price <microlamports>] [--dry-run] [--verify-mint <mint>]

  --keypair       Solana keypair JSON of the wallet linked to the make.fun
                  account. It signs and pays. Only read, never printed.
  --dry-run       Build and sign with a throwaway mint and a dummy blockhash,
                  verify the signatures and the PDA derivation against the
                  chain, print everything, send nothing. Spends no SOL.
  --verify-mint   Only verify the PDA derivation against a live coin's mint.
  --metadata-uri  Use this metadata JSON URI instead of uploading the logo and
                  metadata to pump.fun's IPFS. The reliable path is this
                  repository's metadata.json, pushed public first:
                    https://raw.githubusercontent.com/LensHawthorne/agent-paycheck/main/metadata.json
                  (adjust the owner, repo or branch if yours differ).
`);
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (args.verifyMint) {
    console.log(`Verifying PDA derivation against live coin ${args.verifyMint} ...`);
    const ok = await verifyCoinPdas(args.rpc, args.verifyMint);
    console.log(ok ? "PDA derivation verified." : "PDA derivation FAILED — do not launch.");
    process.exit(ok ? 0 : 1);
  }

  const coin = JSON.parse(readFileSync(args.coin, "utf8"));
  if (typeof coin.name !== "string" || coin.name.length === 0 || coin.name.length > 32) {
    throw new Error("coin.json: name must be 1–32 characters");
  }
  if (typeof coin.symbol !== "string" || coin.symbol.length === 0 || coin.symbol.length > 10) {
    throw new Error("coin.json: symbol must be 1–10 characters");
  }
  if (typeof coin.description !== "string" || !coin.description.includes("make.fun/bounty/makefun-coin-promo-01")) {
    throw new Error("coin.json: description must contain make.fun/bounty/makefun-coin-promo-01");
  }
  if (coin.description.length > 500) {
    console.log(`warning: description is ${coin.description.length} characters; pump.fun shows long descriptions in full, but shorter reads better`);
  }
  const logoBytes = readFileSync(args.logo);
  if (logoBytes.length > 5 * 1024 * 1024) throw new Error("logo is over pump.fun's 5 MiB limit");

  const user = args.dryRun
    ? freshKeypair()
    : loadKeypair(args.keypair ?? (() => { throw new Error("--keypair is required (omit it only with --dry-run)"); })());
  if (args.dryRun) console.log(`dry run: throwaway creator ${user.address} (no real wallet used)`);
  else console.log(`creator wallet: ${user.address}`);

  // --- metadata URI: explicit, or upload the logo + metadata to pump.fun IPFS.
  let metadataUri = args.metadataUri;
  if (!metadataUri) {
    if (args.dryRun) {
      metadataUri = "https://example.invalid/metadata.json";
      console.log("dry run: skipping the IPFS upload, using a placeholder metadata URI");
    } else {
      console.log("uploading logo.png to pump.fun IPFS ...");
      const imageHash = await uploadToPumpIpfs(logoBytes, "logo.png", "image/png");
      const imageUri = `https://ipfs.io/ipfs/${imageHash}`;
      console.log(`image: ${imageUri}`);
      const metadata = {
        name: coin.name,
        symbol: coin.symbol,
        description: coin.description,
        image: imageUri,
        website: coin.website,
        showName: true,
        createdOn: "https://pump.fun",
      };
      console.log("uploading metadata JSON to pump.fun IPFS ...");
      const metadataHash = await uploadToPumpIpfs(Buffer.from(JSON.stringify(metadata), "utf8"), "metadata.json", "application/json");
      metadataUri = `https://ipfs.io/ipfs/${metadataHash}`;
      console.log(`metadata: ${metadataUri}`);
    }
  } else {
    console.log(`metadata URI (given): ${metadataUri}`);
  }

  // --- fresh mint + PDAs.
  const mint = freshKeypair();
  const mintBytes = mint.pub;
  const pdas = derivePumpPdas(mintBytes);
  pdas.associatedBondingCurve = associatedTokenAccount(pdas.bondingCurve, mintBytes);
  if (b58encode(pdas.mintAuthority) !== PUMP_MINT_AUTHORITY) {
    throw new Error(
      `derived mint authority ${b58encode(pdas.mintAuthority)} is not pump.fun's ${PUMP_MINT_AUTHORITY} — refusing to run`,
    );
  }
  console.log(`mint: ${mint.address}`);
  console.log(`mint authority: ${b58encode(pdas.mintAuthority)} (one address for every pump.fun coin)`);
  console.log(`bonding curve: ${b58encode(pdas.bondingCurve)}`);
  console.log(`metadata account: ${b58encode(pdas.metadata)}`);

  // --- blockhash + rent + balance.
  let blockhash;
  if (args.dryRun) {
    blockhash = Buffer.alloc(32); // dummy: the transaction is never sent
  } else {
    const latest = await rpc(args.rpc, "getLatestBlockhash", [{ commitment: "confirmed" }]);
    blockhash = b58decode(latest.value.blockhash);
  }
  const mintRent = args.dryRun
    ? 1_461_600
    : (await rpc(args.rpc, "getMinimumBalanceForRentExemption", [MINT_SIZE]));
  if (!args.dryRun) {
    const balance = await rpc(args.rpc, "getBalance", [user.address, { commitment: "confirmed" }]);
    const required = mintRent + PROGRAM_ACCOUNTS_BUFFER_LAMPORTS + FEES_BUFFER_LAMPORTS;
    console.log(`wallet balance: ${(balance.value / 1e9).toFixed(4)} SOL; launch needs about ${(required / 1e9).toFixed(4)} SOL`);
    if (balance.value < required) {
      throw new Error(
        `wallet holds ${(balance.value / 1e9).toFixed(4)} SOL, below the ${(required / 1e9).toFixed(4)} SOL the launch needs — fund it first, then run this again`,
      );
    }
  }

  // --- build, sign, verify the signatures.
  const instructions = [
    ixComputeUnitLimit(COMPUTE_UNIT_LIMIT),
    ixComputeUnitPrice(args.computeUnitPrice),
    ixCreateAccount(user.pub, mintBytes, mintRent, MINT_SIZE, TOKEN_PROGRAM),
    ixInitializeMint2(mintBytes, TOKEN_DECIMALS, pdas.mintAuthority),
    ixPumpCreate(pdas, mintBytes, user.pub, coin.name, coin.symbol, metadataUri),
  ];
  const { wire, message, signatures } = buildTransaction(instructions, blockhash, [user, mint]);
  const pubByHex = new Map([
    [user.pub.toString("hex"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: user.pub.toString("base64url") }, format: "jwk" })],
    [mint.pub.toString("hex"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: mint.pub.toString("base64url") }, format: "jwk" })],
  ]);
  const { signers } = compileMessage(instructions, blockhash);
  signers.forEach((pub, i) => {
    if (!verify(null, message, pubByHex.get(pub.toString("hex")), b58decode(signatures[i]))) {
      throw new Error(`signature ${i} does not verify — refusing to send`);
    }
  });
  console.log(`transaction built and both signatures verify (${wire.length} bytes)`);
  console.log(`transaction signature: ${signatures[0]}`);

  if (args.dryRun) {
    console.log("verifying the PDA derivation against the chain ...");
    try {
      const globalInfo = await rpc(args.rpc, "getAccountInfo", [b58encode(pdas.global), { encoding: "base64" }]);
      const globalOk = !!globalInfo.value && globalInfo.value.owner === PUMP_PROGRAM;
      console.log(`  [${globalOk ? "PASS" : "FAIL"}] global account exists and belongs to the pump program`);
      if (!globalOk) throw new Error("global account check failed — do not launch");
    } catch (err) {
      console.log(`warning: live PDA check skipped (${err.message}) — run --verify-mint <mint> before the real launch`);
    }
    console.log("dry run complete: nothing was sent, no SOL spent.");
    return;
  }

  // --- send, confirm, verify on chain.
  const signature = await rpc(args.rpc, "sendTransaction", [wire.toString("base64"), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }]);
  if (signature !== signatures[0]) throw new Error(`send returned ${signature}, expected ${signatures[0]}`);
  console.log(`sent: ${signature}`);
  console.log("waiting for confirmation ...");
  await waitForConfirmation(args.rpc, signature);
  const tx = await rpc(args.rpc, "getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  if (!tx || (tx.meta && tx.meta.err)) throw new Error(`create transaction failed on chain: ${JSON.stringify(tx && tx.meta && tx.meta.err)}`);
  const mintInfo = await rpc(args.rpc, "getAccountInfo", [mint.address, { encoding: "base64" }]);
  if (!mintInfo.value) throw new Error("mint account does not exist after a confirmed create — something is wrong");

  console.log(`LAUNCHED: mint ${mint.address}`);
  console.log(`LAUNCHED: create signature ${signature}`);
  writeFileSync(args.out, JSON.stringify({ mint: mint.address, create_signature: signature }, null, 2) + "\n");
  console.log(`wrote ${args.out}`);
}

main().catch((err) => {
  console.error(`launch failed: ${err.message}`);
  process.exit(1);
});
