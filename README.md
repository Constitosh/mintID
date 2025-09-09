# Cardano Open-Policy Mint — "Pay then Airdrop" Starter

This is a **minimal** Node + Lucid server that:
- Watches a **mint address** for **exactly 5 ₳** payments
- Enforces **one mint per stake key**
- **Mints 1 random NFT** (from 5 designs) under an **open native policy**
- Sends the NFT back to the payer address (with min ADA)
- Exposes `/api/info`, `/api/status/:stake`, and a simple static page in `public/`

> Use a **burner mnemonic** for the server wallet. Fund it with ADA to cover **min ADA** + **fees**.

## Quickstart

```bash
# 1) copy & edit env
cp .env.example .env

# 2) install deps
npm install

# 3) run
npm run dev
```

Open http://localhost:3002 to see the simple page.

## Notes
- **Policy is open** (sig-only native script). Keep your server seed safe.
- **Min ADA:** server sends ~1.5 ADA along with the NFT.
- **Randomness:** uniform across entries in `src/designs.json`.
- **Blockfrost:** used for both Lucid provider and REST polling.
