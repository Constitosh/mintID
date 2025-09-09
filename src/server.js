// Minimal "Pay then Airdrop" open-policy mint server
// Node 18+ required
import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import { Lucid, Blockfrost, fromText } from 'lucid-cardano';

const app = express();
app.use(express.static('public'));

// ---- ENV ----
const NETWORK = process.env.NETWORK?.trim() || 'Mainnet'; // 'Mainnet' or 'Preprod'
const BLOCKFROST_KEY = process.env.BLOCKFROST_KEY;
const PRICE = BigInt(process.env.PRICE_LOVELACE || '15000000'); // 15 ADA default
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || '6000');
const SERVER_MNEMONIC = process.env.SERVER_MNEMONIC;
if (!BLOCKFROST_KEY || !SERVER_MNEMONIC) {
  console.error('Missing BLOCKFROST_KEY or SERVER_MNEMONIC in .env');
  process.exit(1);
}

const BF_URL = NETWORK === 'Mainnet'
  ? 'https://cardano-mainnet.blockfrost.io/api/v0'
  : 'https://cardano-preprod.blockfrost.io/api/v0';

// ---- DB ----
const db = new Database('mint.sqlite');
db.pragma('journal_mode = wal');
db.exec(`
CREATE TABLE IF NOT EXISTS mints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stake_key TEXT UNIQUE,
  payer_address TEXT,
  paid_tx TEXT UNIQUE,
  minted_tx TEXT,
  asset_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS seen_utxos (
  utxo TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// ---- Lucid setup ----
let lucid;
let serverAddress;
let policyScriptJson;
let policyId;

async function initLucid() {
  lucid = await Lucid.new(new Blockfrost(BF_URL, BLOCKFROST_KEY), NETWORK);
  await lucid.selectWalletFromSeed(SERVER_MNEMONIC);

  serverAddress = await lucid.wallet.address();

  // derive payment key hash from the server address
  const addrDetails = lucid.utils.getAddressDetails(serverAddress);
  const keyHash = addrDetails.paymentCredential?.hash;
  if (!keyHash) throw new Error('Failed to derive payment key hash');

  // native script JSON (sig-only, open policy)
  const nativeScriptJson = {
    type: 'all',
    scripts: [{ type: 'sig', keyHash }]
  };

  // IMPORTANT: convert JSON -> MintingPolicy
  mintingPolicy = lucid.utils.nativeScriptFromJson(nativeScriptJson);

  // Now we can compute the policyId from the MintingPolicy
  policyId = lucid.utils.mintingPolicyToId(mintingPolicy);

  console.log('Server address:', serverAddress);
  console.log('Policy ID:', policyId);
}

// ---- Helpers ----
async function fetchJson(path) {
  const r = await fetch(`${BF_URL}${path}`, {
    headers: { project_id: BLOCKFROST_KEY }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Blockfrost ${path} -> ${r.status}: ${t}`);
  }
  return r.json();
}

function getStakeKeyFromAddr(address) {
  try {
    const d = lucid.utils.getAddressDetails(address);
    return d.stakeCredential?.hash || null;
  } catch {
    return null;
  }
}

function pickRandomDesign() {
  const designs = JSON.parse(require('node:fs').readFileSync(new URL('./designs.json', import.meta.url)));
  const i = Math.floor(Math.random() * designs.length);
  return designs[i];
}

async function mintAndSend(payerAddress, stakeKey, paidTx) {
  // safety: ensure one-per-stake enforced at DB level too
  const insert = db.prepare(`INSERT OR IGNORE INTO mints (stake_key, payer_address, paid_tx) VALUES (?, ?, ?)`);
  const res = insert.run(stakeKey, payerAddress, paidTx);
  if (res.changes === 0) {
    console.log('Duplicate attempt for stake:', stakeKey);
    return;
  }

  const design = pickRandomDesign();
  const unit = policyId + fromText(design.name);

  // CIP-25 v2 metadata object for this single asset
  const metadata721 = {
    [policyId]: {
      [design.name]: {
        name: design.name.replaceAll('_', ' '),
        image: `ipfs://${design.cid}`,
        mediaType: design.mediaType || 'image/png',
        files: [{ src: `ipfs://${design.cid}`, mediaType: design.mediaType || 'image/png' }],
        description: 'One of five designs.'
      }
    },
    version: '2.0'
  };

  const MIN_ADA = 1500000n; // include min ADA with the NFT

  const tx = await lucid.newTx()
    .mintAssets({ [unit]: 1n })
    .attachMetadata(721, metadata721)
    .attachMintingPolicy(mintingPolicy)
    .payToAddress(payerAddress, { [unit]: 1n, lovelace: MIN_ADA })
    .complete();

  const signed = await tx.sign().complete();
  const txHash = await signed.submit();

  db.prepare(`UPDATE mints SET minted_tx=?, asset_name=? WHERE paid_tx=?`)
    .run(txHash, design.name, paidTx);

  console.log(`Minted ${design.name} to ${payerAddress} in tx ${txHash}`);
  return txHash;
}

// ---- Watcher ----
// We look for new UTxOs at the server address that are exactly PRICE lovelace (5 ADA) with no other assets.
async function scanForPayments() {
  try {
    const utxos = await fetchJson(`/addresses/${serverAddress}/utxos?order=desc&count=100`);
    for (const u of utxos) {
      const utxoId = `${u.tx_hash}#${u.output_index}`;
      // skip if already processed
      const seen = db.prepare(`SELECT 1 FROM seen_utxos WHERE utxo=?`).get(utxoId);
      if (seen) continue;

      // amount is an array like [{unit:'lovelace', quantity:'5000000'}, ...]
      const onlyLovelace = u.amount.length === 1 && u.amount[0].unit === 'lovelace';
      const qty = onlyLovelace ? BigInt(u.amount[0].quantity) : 0n;
      if (!(onlyLovelace && qty === PRICE)) {
        // mark as seen to avoid re-checking spam outputs
        db.prepare(`INSERT OR IGNORE INTO seen_utxos (utxo) VALUES (?)`).run(utxoId);
        continue;
      }

      // Find the payer's address from tx inputs
      const txUtxos = await fetchJson(`/txs/${u.tx_hash}/utxos`);
      const firstInput = txUtxos?.inputs?.[0];
      const payerAddr = firstInput?.address;
      if (!payerAddr) {
        console.warn('No payer address found for tx', u.tx_hash);
        db.prepare(`INSERT OR IGNORE INTO seen_utxos (utxo) VALUES (?)`).run(utxoId);
        continue;
      }
      const stakeKey = getStakeKeyFromAddr(payerAddr);
      if (!stakeKey) {
        console.warn('No stake key on payer address; skipping tx', u.tx_hash);
        db.prepare(`INSERT OR IGNORE INTO seen_utxos (utxo) VALUES (?)`).run(utxoId);
        continue;
      }

      // Enforce one-per-stake
      const already = db.prepare(`SELECT 1 FROM mints WHERE stake_key=?`).get(stakeKey);
      if (already) {
        console.log('Stake already minted; ignoring payment', stakeKey, u.tx_hash);
        db.prepare(`INSERT OR IGNORE INTO seen_utxos (utxo) VALUES (?)`).run(utxoId);
        continue;
      }

      // Proceed to mint and send
      try {
        const mintedTx = await mintAndSend(payerAddr, stakeKey, u.tx_hash);
        db.prepare(`INSERT OR IGNORE INTO seen_utxos (utxo) VALUES (?)`).run(utxoId);
        if (mintedTx) console.log('Processed payment', u.tx_hash, '->', mintedTx);
      } catch (e) {
        console.error('Mint failed for', u.tx_hash, e);
      }
    }
  } catch (e) {
    console.error('scan error:', e.message);
  }
}

// ---- API ----
app.get('/api/info', async (_req, res) => {
  res.json({
    network: NETWORK,
    price_lovelace: PRICE.toString(),
    mint_address: serverAddress,
    policy_id: policyId
  });
});

// Optional: user signs a message client-side and posts it here just for audit
app.post('/api/intent', async (req, res) => {
  // store the signed blob in DB if you want; for simplicity we just ack
  res.json({ ok: true });
});

// Status by stake key (very basic)
app.get('/api/status/:stake', (req, res) => {
  const row = db.prepare(`SELECT * FROM mints WHERE stake_key=?`).get(req.params.stake);
  if (!row) return res.json({ status: 'none' });
  if (!row.minted_tx) return res.json({ status: 'paid', paid_tx: row.paid_tx });
  return res.json({ status: 'minted', minted_tx: row.minted_tx, asset: row.asset_name });
});

// ---- Boot ----
const PORT = process.env.PORT || 3003;
initLucid().then(() => {
  app.listen(PORT, () => console.log('Mint server on :' + PORT));
  setInterval(scanForPayments, POLL_MS);
  // do an immediate scan on boot
  scanForPayments();
});
