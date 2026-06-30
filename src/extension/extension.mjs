/**
 * Runnable Copilot CLI extension entry (PE3-F5).
 *
 * Discovery loads `extension.mjs`; this file is the thin shim the host executes.
 * All logic lives in {@link module:src/extension/index}; here we just invoke
 * `main()`, which dynamically resolves `@github/copilot-sdk/extension` and binds
 * the affordance tools + canvas via a single `joinSession({ canvases, tools })`.
 *
 * stdout is reserved for JSON-RPC, so failures are reported on stderr only.
 *
 * @module src/extension/extension
 */

import { main } from './index.js';

main().catch((err) => {
  process.stderr.write(`[kbx-extension] failed to join session: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
