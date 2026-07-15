#!/usr/bin/env node
/**
 * Dar Al Takwa transparency verifier — zero dependencies, Node ≥ 20.
 *
 * Recomputes every hash in a checkpoint export and compares against the
 * committed values, so you don't have to trust the platform:
 *
 *   node verify.mjs <export.json path-or-URL> [previous-export path-or-URL] [--live]
 *
 * Examples:
 *   node verify.mjs checkpoints/2026/cp-000002.json checkpoints/2026/cp-000001.json
 *   node verify.mjs https://raw.githubusercontent.com/omtoc/daraltakwa-transparency-dev/main/checkpoints/2026/cp-000002.json
 *
 * Steps: (1) every event re-serialized canonically and leaf-hashed,
 * (2) Merkle root recomputed (RFC 6962), (3) checkpoint hash recomputed,
 * (4) chain link to the previous checkpoint (when provided),
 * (5) --live: spot-check donation/report events against the public Firestore
 *     REST endpoints (no credentials — this data is world-readable).
 *
 * The Bitcoin anchor is verified separately with the OpenTimestamps client:
 *   ots verify -d <checkpointHash> proofs/<year>/cp-<seq>.ots
 *
 * These hashing rules mirror the platform's functions/src/_lib/merkle.ts —
 * any divergence is a protocol break, not a tweak.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ── Canonical field orders (the serialization contract) ─────────────────────
const FIELD_ORDER = {
  donation: ['kind', 'id', 'campaignId', 'charityId', 'amountSYP', 'paymentMethod', 'status', 'occurredAt'],
  transition: ['kind', 'id', 'ref', 'from', 'to', 'occurredAt'],
  disbursement: ['kind', 'id', 'campaignId', 'charityId', 'amountSYP', 'occurredAt'],
  report: ['kind', 'id', 'disbursementId', 'campaignId', 'charityId', 'reportType', 'totalSYP', 'unspentReturnSYP', 'lineItems', 'occurredAt'],
  return: ['kind', 'id', 'campaignId', 'charityId', 'amountSYP', 'occurredAt'],
};
const LINE_ITEM_FIELD_ORDER = ['vendorAr', 'vendorEn', 'amountSYP', 'categoryId', 'date', 'isUnreceipted'];

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const be8 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

function pickOrdered(source, order, context) {
  const extras = Object.keys(source).filter((k) => !order.includes(k));
  if (extras.length) throw new Error(`unexpected field(s) [${extras}] on ${context}`);
  const out = {};
  for (const f of order) {
    if (source[f] === undefined || source[f] === null) throw new Error(`missing field '${f}' on ${context}`);
    out[f] = typeof source[f] === 'string' ? source[f].normalize('NFC') : source[f];
  }
  return out;
}

function canonicalBytes(event) {
  const order = FIELD_ORDER[event.kind];
  if (!order) throw new Error(`unknown kind '${event.kind}'`);
  const canon = pickOrdered(event, order, `${event.kind} event`);
  if (event.kind === 'report') {
    canon.lineItems = event.lineItems.map((l, i) => pickOrdered(l, LINE_ITEM_FIELD_ORDER, `lineItems[${i}]`));
  }
  return Buffer.from(JSON.stringify(canon), 'utf8');
}

const leafHash = (bytes) => sha256(Buffer.from([0x00]), bytes);
const nodeHash = (l, r) => sha256(Buffer.from([0x01]), l, r);

function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    level = next;
  }
  return level[0];
}

const checkpointHash = (h, rootBytes) =>
  sha256(
    Buffer.from([0x02]),
    be8(h.seq),
    Buffer.from(h.prevCheckpointHash, 'hex'),
    rootBytes,
    be8(h.eventCount),
    be8(h.window.toInclusiveMillis),
  );

// ── IO ───────────────────────────────────────────────────────────────────────
async function load(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetch ${source}: ${res.status}`);
    return JSON.parse(await res.text());
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

const PUBLIC_SOURCES = {
  donation: (id) =>
    `https://firestore.googleapis.com/v1/projects/darat-donor-dev/databases/(default)/documents/donations/${id}`,
  report: (id) =>
    `https://firestore.googleapis.com/v1/projects/darat-charity-dev/databases/(default)/documents/proof_submissions/${id}`,
};

async function liveSpotCheck(events) {
  const candidates = events.filter((e) => e.kind === 'donation' || e.kind === 'report');
  const sample = candidates.slice(0, 3);
  for (const ev of sample) {
    const docId = ev.id.split(':')[1];
    const url = PUBLIC_SOURCES[ev.kind](docId);
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  live ${ev.id}: NOT FOUND (${res.status}) — investigate`);
      continue;
    }
    const doc = await res.json();
    const amountField = ev.kind === 'donation' ? 'amountSYP' : 'totalSYP';
    const liveAmount = Number(doc.fields?.[amountField]?.integerValue ?? NaN);
    const ok = liveAmount === ev[amountField];
    console.log(`  live ${ev.id}: ${ok ? 'MATCHES' : `MISMATCH (live ${liveAmount} vs sealed ${ev[amountField]})`}`);
  }
  if (sample.length === 0) console.log('  (no publicly fetchable event kinds in this checkpoint)');
}

// ── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter((a) => a !== '--live');
const live = process.argv.includes('--live');
if (args.length < 1) {
  console.error('usage: node verify.mjs <export.json path-or-URL> [previous-export] [--live]');
  process.exit(2);
}

const { header, events } = await load(args[0]);
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures += 1;
};

console.log(`\nVerifying checkpoint cp-${String(header.seq).padStart(6, '0')} (${events.length} events)\n`);

check('event count matches header', events.length === header.eventCount, `${events.length} vs ${header.eventCount}`);

const leaves = events.map((e) => leafHash(canonicalBytes(e)));
const root = merkleRoot(leaves);
check('merkle root recomputes', root.toString('hex') === header.merkleRoot, root.toString('hex'));

const cp = checkpointHash(header, root);
check('checkpoint hash recomputes', cp.toString('hex') === header.checkpointHash, cp.toString('hex'));

const ordered = events.every(
  (e, i) => i === 0 || events[i - 1].occurredAt < e.occurredAt ||
    (events[i - 1].occurredAt === e.occurredAt && events[i - 1].id < e.id),
);
check('events are canonically ordered', ordered);

if (args[1]) {
  const prev = await load(args[1]);
  const prevRoot = merkleRoot(prev.events.map((e) => leafHash(canonicalBytes(e))));
  const prevCp = checkpointHash(prev.header, prevRoot);
  check('chain link to previous checkpoint', prevCp.toString('hex') === header.prevCheckpointHash);
} else {
  console.log('  SKIP  chain link (pass the previous export as a second argument)');
}

if (live) {
  console.log('\nLive spot-check against public Firestore endpoints:');
  await liveSpotCheck(events);
}

console.log(
  failures === 0
    ? `\nALL CHECKS PASSED — this checkpoint's contents cannot have been altered\nsince it was anchored. To verify the Bitcoin anchor:\n  ots verify -d ${header.checkpointHash} proofs/<year>/cp-${String(header.seq).padStart(6, '0')}.ots\n`
    : `\n${failures} CHECK(S) FAILED — this export does NOT match its committed hashes.\n`,
);
process.exit(failures === 0 ? 0 : 1);
