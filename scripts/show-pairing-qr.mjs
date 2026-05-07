/**
 * Print the local daemon's pairing QR + credentials, kept open so a phone
 * can scan it. Run from a regular terminal:
 *
 *   cd /Users/soami/Desktop/code/int/overwatch
 *   npx tsx scripts/show-pairing-qr.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import qrcode from "qrcode-terminal";

const p = JSON.parse(readFileSync(homedir() + "/.overwatch/pairing.json", "utf8"));
const qrData = JSON.stringify({
  r: "https://overwatch-relay.soami.workers.dev",
  u: p.userId,
  t: p.pairingToken,
});

console.log("\n  Overwatch pairing — scan with the mobile app\n");
qrcode.generate(qrData, { small: false }, (code) => console.log(code));
console.log(`  user_id:       ${p.userId}`);
console.log(`  pairing_token: ${p.pairingToken}`);
console.log(`  relay_url:     https://overwatch-relay.soami.workers.dev\n`);
console.log("  Leave this window open while you scan. Press Ctrl-C to close.\n");

process.stdin.resume();
