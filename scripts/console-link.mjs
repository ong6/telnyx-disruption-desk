#!/usr/bin/env node
// Prints the ops console link that unlocks the controls in whichever browser opens it once
// (the token moves from the URL into that browser's localStorage and leaves the address bar).
// Usage: source scripts/env.sh && node scripts/console-link.mjs
console.log(`https://desk-ops-68bad318-0.telnyxcompute.com/#key=${encodeURIComponent(process.env.DESK_ADMIN_TOKEN ?? "")}`);
