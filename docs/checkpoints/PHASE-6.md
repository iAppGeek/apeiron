# Phase 6: Actions (Cancel / Pause / Resume)

Branch `phase-6-actions`. Stack rebuilt with `docker compose --profile core up -d --build antikythera hermes pharos` and left running on Medium.

## What was built
- **logos**
  - `COMMAND_ACTIONS`, `COMMAND_TARGET`, `canTransition`, `canApplyCommand`, `availableCommands`, `applyCommand` (built on `transition()`), `makeCommandId`, `REJECT_CODES`.
  - The command, `UPDATE{commandId?}` and `REJECT` schemas already existed from earlier phases; they now reuse the shared constants.
- **hermes**
  - Durable consumer `hermes-commands` on `orders.commands`.
  - `Simulator.command()` applies valid transitions and publishes `UPDATE` (with `commandId`, absolute values) or `REJECT` (`INVALID_TRANSITION`, `UNKNOWN_ORDER`).
  - The command is acked only after the answering event is published; if that publish fails it stays unacked.
  - PAUSED orders get no fills.
  - Invalid payloads and commands older than 30s are dropped and acked.
- **antikythera**
  - `CommandCorrelator` (pending map keyed by `commandId`, 5s timeout -> `error{INTERNAL,'command timed out'}`, dropped when the session closes).
  - `LiveRuntime.command()` does the fast pre-check (`UNKNOWN_ORDER`, `INVALID_TRANSITION`) against the store, then publishes.
  - An `UPDATE` with a matching `commandId` is applied normally; `ack` is sent to the asker after the flush that sent the delta. `REJECT` becomes `error{reqId, code, message}`.
  - Sessions validate `command` with zod (existing `clientMsgSchema`).
- **pharos**
  - `ContextMenuModule` and `ClipboardModule` registered. The menu (right-click or the ContextMenu key) shows Cancel / Pause / Resume enabled by the row's status, then Copy and Copy with Headers. Group rows and non-order areas get copy items only.
  - Cancel opens an inline confirmation submenu ("Confirm: cancel <id>"). Pause and Resume run directly.
  - `client.command(orderId, action)` returns a promise settled by `ack` / `error`.
  - In-progress indicator: the status chip is dimmed with a spinner (`aria-busy`) until the ack or error.
  - Error toasts per `ErrorCode` (`describeCommandFailure`).

## Deviations / decisions
1. **RESUME is narrower than the lifecycle.** `transition()` allows PENDING_START to LIVE (the clock's job); `canApplyCommand` restricts RESUME to PAUSED so RESUME on PENDING_START is `INVALID_TRANSITION` (found by the matrix test).
2. **Resume extends `endTime` by the paused duration.** Without it an order paused past its end time was completed (FILLED) at once on resume instead of carrying on (seen live on the first attempt; orders live only 1-2 minutes on Medium). Hermes emits the absolute new `endTime` in the resume UPDATE.
3. **ClipboardModule added** (same `ag-grid-enterprise` package) so the standard copy items work. No new dependency.
4. **Cancel confirm is a submenu**, not a dialog. A native hover or click opens it; it opens to the left near the right viewport edge.
5. Extra server option `commandTimeoutMs` (default 5000) so tests can shorten it.
6. Keyboard: the ContextMenu key opens the menu (Shift+F10 did not in the Playwright run); ArrowUp/Down navigate, Enter activates, disabled items do nothing, Escape closes.
7. No plan contract was changed.

## Verification (raw)
`pnpm lint && pnpm typecheck && pnpm test && pnpm build` all exit 0 (the build is cached by turbo).
```
logos       Tests 156 passed (12 files)
gaia        Tests  25 passed
pharos      Tests 379 passed (34 files)
mnemosyne   Tests  35 passed
iris        Tests   9 passed, 2 skipped
hermes      Tests  56 passed (7 files)
antikythera Tests 386 passed (38 files)
Tasks: 10 successful, 10 total
```
Note: one full run had `system-stats.spec.ts` ("cumulative lag histogram", an existing timing-sensitive test, `max < 50` got 84.5) fail while the Docker stack and parallel turbo tasks loaded the machine. It passed on rerun and in isolation.

New tests: logos transition x command matrix (15 combinations), command ids and schemas; hermes simulator and bus command handling (valid, invalid, unknown, ack, unacked on publish failure, stale and invalid dropped, resume end-time); antikythera correlator, runtime correlation (ack after delta, REJECT, timeout, session close, pre-check, publish failure, duplicate id), session wiring, and a real-socket integration suite with an in-memory-bus hermes (json and msgpack); pharos menu items per status x action, confirm flow, in-progress chip, error toasts, client `command`.

## Live verification (Medium preset, rebuilt containers, real Playwright clicks)
| Step | Result |
|---|---|
| Filter status = LIVE; Pause a LIVE order | Right-click, Pause order. Independent watcher socket: click at t, `status: PAUSED` update at t+29ms (first attempt, ALG01061479) and +? ms for ALG01064390 (click 753723 -> PAUSED 753752). |
| Fills stop for 10s | ALG01061479: last fill (filledQty 1,293,000) before the pause, then no fill update for the 32s it stayed paused. ALG01064390: PAUSED for 11.5s with zero fill updates. |
| Resume | ALG01064390: click at 765250, `LIVE` at 765268 (18ms); fills resumed at +4.9s (filledQty 131,000 then 285,000, 462,000, 618,000). Resume update carried the new `endTime`. |
| Cancel with confirm | Cancel order opens "Confirm: cancel ALG01063571"; confirming made it CANCELLED (row left the LIVE/PAUSED filter, CANCELLED count rose). |
| Cancel on FILLED | Menu: Cancel / Pause / Resume all disabled, Copy enabled; clicking a disabled item did nothing, no toast. |
| Raw WebSocket (Node, `probe.cjs`) | Output below. |
| Error toast | Another client cancelled the order while the menu (built from LIVE) was open; choosing Pause gave the toast "Pause failed for ALG01064667: Cannot pause an order that is CANCELLED." |
| Keyboard | Click the cell, ContextMenu key, ArrowDown x2 reaches Resume (disabled; Enter did nothing), ArrowUp to Pause, Enter: PAUSED count 1. |

Raw WebSocket probe output:
```
{"t":"error","reqId":1,"code":"HELLO_REQUIRED","message":"Send hello first"}
{"t":"error","reqId":10,"code":"INVALID_TRANSITION","message":"Cannot cancel an order that is FILLED"}
{"t":"error","reqId":11,"code":"INVALID_TRANSITION","message":"Cannot pause an order that is FILLED"}
{"t":"error","reqId":12,"code":"INVALID_TRANSITION","message":"Cannot resume an order that is FILLED"}
{"t":"error","reqId":13,"code":"UNKNOWN_ORDER","message":"Order ALG99999999 does not exist"}
{"t":"error","reqId":14,"code":"BAD_MESSAGE","message":"action: Invalid option: expected one of \"CANCEL\"|\"PAUSE\"|\"RESUME\""}
{"t":"error","reqId":15,"code":"BAD_MESSAGE","message":"orderId: Too small: expected string to have >=1 characters"}
{"t":"error","reqId":16,"code":"BAD_MESSAGE","message":"action: Invalid option: expected one of \"CANCEL\"|\"PAUSE\"|\"RESUME\""}
```

### Round-trip latency (14 commands: 7 Pause + 7 Resume, real menu clicks)
Measured in the page: a capture-phase click listener on the menu item gives t0; a MutationObserver on the status cell gives the moment the status text changed on screen and the moment the in-progress spinner went away (the `ack`).

| Metric | click to status on screen | click to ack (spinner gone) |
|---|---|---|
| p50 | 57.9 ms | 63.7 ms |
| p95 | 89.0 ms | 110.7 ms |
| min / max | 16.2 / 89.0 ms | 16.2 / 110.7 ms |

Samples (ms), status: 16.2, 16.7, 34.2, 42.9, 57.7, 57.7, 57.9, 59.8, 64.9, 66.6, 69.7, 72.1, 87.1, 89.0. Ack: 16.2, 16.9, 34.2, 42.9, 57.7, 57.9, 63.7, 68.9, 69.6, 69.7, 72.3, 91.7, 93.2, 110.7. Nearest-rank percentiles. Target 500ms; stop threshold 1s: not approached. The ack always follows the delta (same flush), at most about 5ms later.

Harness note: in a few attempts the harness lost its row handle (rows churn at ~10 orders/s) and recorded nothing for that command; the commands themselves had succeeded (11 orders were found PAUSED and resumed by a cleanup script). Those attempts are excluded from the 14.

### Screenshots (`docs/screenshots/phase-6/`)
- `01-context-menu-live-row.png`: context menu on a LIVE row
- `02-cancel-confirm.png`: Cancel confirmation submenu
- `03-paused-row.png`: a PAUSED row
- `04-error-toast.png`: error toast
- `05-filled-row-menu-disabled.png`: all three actions disabled on a FILLED row
- `06-keyboard-menu.png`: keyboard navigation

## Versions and exceptions
No new dependencies. TypeScript ~6.0.3, AG Grid 36.2 (`ContextMenuModule` and `ClipboardModule` from `ag-grid-enterprise`), React 19.3, Vitest 5, zod 4.6, NATS 2.15, MongoDB 9.0. Exceptions: none beyond the existing ones.

## Known weaknesses
- The `ack` means "applied in the server's store and delta sent", not "persisted"; write-behind is asynchronous.
- A stale pre-check (status changed between menu open and server receipt) is answered by the server's own pre-check or by hermes; the first is cheap, the second a round trip. Both give a toast.
- Hermes drops commands older than 30s on redelivery; an unacknowledged command for a crashed hermes is lost from the user's view after the 5s timeout.
- If hermes has restarted, a PAUSED order's pause time is its stored `lastUpdateTime`, so the resumed `endTime` extension is approximate.
- PAUSED orders never expire on their own (they stay PAUSED until resumed or cancelled).
- Group-row behaviour (no order actions) is covered by unit tests only, not clicked live.
- Shift+F10 did not open the menu in the Playwright run; the ContextMenu key did.
- The `system-stats` lag test is timing-sensitive under load (see above).
