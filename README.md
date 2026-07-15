# Dar Al Takwa — Transparency Checkpoints (DEVELOPMENT)

> ⚠️ **This is the DEVELOPMENT environment.** Every donation, campaign, and
> expenditure anchored here is **test data** from the platform's dev projects.
> At production launch this repository is retired and a fresh one starts with
> its own genesis checkpoint over real data.
>
> ⚠️ **هذه بيئة التطوير.** جميع التبرعات والحملات والمصروفات المرسّخة هنا
> **بيانات تجريبية** من مشاريع التطوير. عند الإطلاق الرسمي يُتقاعد هذا
> المستودع ويبدأ مستودع جديد بنقطة تحقق أولى خاصة به فوق بيانات حقيقية.

## What is this? · ما هذا؟

Dar Al Takwa publishes every money event on its platform — donations,
disbursements to charities, itemized expense reports, and returned funds.
Once a day, all new public money events are sealed into a **checkpoint**:
a cryptographic fingerprint (a Merkle root) of the events, chained to the
previous checkpoint. Each checkpoint is then anchored **outside the
platform's control**:

1. **This repository** — the full event list (`checkpoints/`) and the
   checkpoint metadata, committed with a public history anyone can clone.
2. **OpenTimestamps** (`proofs/`) — the checkpoint fingerprint is embedded
   into the Bitcoin timeline via free public calendar servers. No
   cryptocurrency is held or moved; only a hash is timestamped.

If the platform ever altered or deleted a published money event after the
fact, the recomputed fingerprints would stop matching these anchors — and
anyone could prove it.

تنشر دار التقوى كل حركة مالية على منصتها. تُختم الأحداث يوميًا في «نقطة
تحقق» — بصمة تشفيرية مسلسلة — وتُرسَّخ خارج سيطرة المنصة: في هذا المستودع
العلني، وفي سجل بيتكوين الزمني عبر OpenTimestamps (دون حيازة أو تحريك أي
عملة رقمية). لو عُدّل أي حدث منشور لاحقًا لتوقفت البصمات عن التطابق —
ويستطيع أي شخص إثبات ذلك.

## What this does NOT prove · ما لا يثبته هذا

- It does **not** prove real-world outcomes (that aid was delivered) — that
  layer is the platform's receipt-backed expense reports, reviewed by
  administrators against original receipts.
- It does **not** prove data was honest when first entered — only that it
  was **never rewritten afterwards**.
- Nothing here identifies donors: the event stream contains only fields that
  are already public on the platform.

## Verify it yourself · تحقق بنفسك

You need Node.js ≥ 20 (and optionally the OpenTimestamps client).

```bash
# 1. Verify a checkpoint's contents and its chain link:
node verify.mjs checkpoints/2026/cp-000002.json checkpoints/2026/cp-000001.json

# 2. Spot-check sealed events against the platform's LIVE public data:
node verify.mjs checkpoints/2026/cp-000002.json --live

# 3. Verify the Bitcoin anchor (pip install opentimestamps-client):
ots verify -d <checkpointHash from the export header> proofs/2026/cp-000002.ots
```

`verify.mjs` recomputes every hash from scratch — it trusts nothing but the
mathematics. The hashing rules (canonical JSON, SHA-256, RFC 6962 Merkle
tree) are documented inside the script.

## Layout

```
checkpoints/<year>/cp-<seq>.json   # header + the full ordered event list
proofs/<year>/cp-<seq>.ots         # OpenTimestamps proof of the checkpoint hash
verify.mjs                         # the verifier (zero dependencies)
```

Checkpoint metadata is also world-readable on the platform itself
(`ledger_checkpoints` on the admin Firestore project) and rendered at the
platform's `/transparency` page.
