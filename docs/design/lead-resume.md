# Preserve sessions and work when resume fails

Status: proposal for owner approval; no product changes. Investigated 2026-11-27 on Linux x64.
Base: main 0.2.5, `8084e2cdd8d18fff2e1e6eb6a72e99fd76c39c47`; PR [#299](https://github.com/vntrevx/Cataly/pull/299), Momentum96, `212bbeed919ad5738d73c047434fd054163f521c` (CLA accepted).

## Decision in brief

**Highest severity: a failed lane resume deletes its record and attempts to remove its worktrees.**
This is not just the lead retry bug. Preserve established identities and work first; then repair startup supervision.
Fold #299 into the approved slices below, retaining Momentum96's attribution. Do not merge it as the complete fix.
A timeout must mean “this attempt failed”, never “this conversation/work no longer exists”.

## Evidence and reproducible failures

All runs used private temporary homes, config/state/socket directories and generated sessions, never owner state.
Only this worktree, #299 and installed stock OMP/public documentation supplied evidence; no earlier implementation was used.
Stock `/home/turing/.bun/bin/omp` reports 19.2.1; SHA-256 `e8b937f9bf023baa147bdd300ad5421af0a6ef8b1f350c47a9a93d5fca94feca`.
The installed npm source tree reports 17.4.0 and was not used to infer 19.2.1 behavior.
All inference went to `tests/support/model.rs`'s loopback fake; direct timing runs sent no prompts and configured a loopback-only fake model.

### Lead: exact sequence on unchanged main

Use `tests/lead.rs`'s `TestHub`, `fake-omp` with `rpc`/`turns`, `[lead] model = "fake/primary"`, and a private cwd.
Wrap the fake executable: on the next `--resume=...` only, consume a one-shot flag, read stdin until EOF without emitting ready, then exit 1; otherwise exec the original fake. The probe must remain unaffected.

1. Start, send `ORIGINAL`, observe its entry in transcript **A**, then stop the hub cleanly.
2. Arm the flag; start the hub and submit `WAITING` while the lead starts.
3. At 15.137 s (unpinned) / 15.310 s (pinned), observe `phase=held`, `no rpc-ui ready frame`, `waiting=1`, `sent=0`, `in_doubt=0`. Inbox row remains `pending`; A contains no `WAITING`.
4. Read the stopped sandbox DB: `(fresh, stopped, session_id=A)` followed by `(resume, failed, session_id=NULL, expected_id=A)`.
5. Restart without the flag. Unpinned: a different **B** starts and receives `WAITING`; A remains on disk, but its conversation is abandoned.
6. Repeat with `session_id=A` added before step 2. The next restart holds: “required lead session ... is not the last lead session ... a fresh lead is never substituted”. **The pin is hidden/refused, not silently replaced while still configured.**
7. Replace step 1's hub stop with debug `CATALY_IDLE_SLEEP=2s` and wait for `asleep`; arm and send `WAITING`. Wake holds after 15.071 s; the same unbound row hides A on the next hub restart, which starts B.

Stock confirmation: run a real lead with the existing fake HTTP model and an explicitly configured extension whose factory waits 16 s only when argv contains `--resume=`. After a clean stop/start, main held the lead at 17.613 s including probe/cleanup. The fake provider's inference-request count was 8 before restart and 8 afterwards: resume did not invoke a model. A first experiment's incorrect assertion of one total request was corrected to compare the pre/post counts; its timeout observation was unchanged.

### Lanes: actual deletion, including worker-side work

Use `tests/lanes.rs`/`tests/workers.rs`'s harness: open a running lane with a recorded session and Cataly-created worktree, then make only resumed fake OMP starts withhold ready until stdin closes.
Local trigger: orderly hub stop/start. Remote trigger: kill the sandbox worker's `serve` PID and let the real worker protocol reconnect through `fake-ssh`; no SSH server or real remote state is used.
In all six worktree cases, `lane list --all` lost the lane after the timeout. Local recap: `not restarted: failed: failed: no rpc-ui ready frame ...`.

| Work present before failure | Local hub restart | Worker drop/reattach |
| --- | --- | --- |
| Modified tracked file plus untracked new file | Both contents survive; Git refuses removal; lane record still deleted | Same, in worker-side directory |
| Clean checkout with an unpushed commit | Worktree removed; commit/content survives on its named branch | Same, branch survives in worker's bare clone |
| Only an ignored file with unique, uncommitted content | Worktree and file deleted; no Git copy | Same: actual worker-side file loss |

Do not claim tracked dirty files or committed objects were erased: the measured loss is ignored-only bytes, the checkout, and/or Cataly's durable ownership record. Retained branches are recoverable but not a substitute for recovery tracking.

Path audit (source, not separate update/queued runtime tests):
- Hub restart and update: `lanes/life.rs:938-1005`, `recover_one -> start(Some(identity))`.
- Worker drop/reattach: `lanes/remote.rs:346-394 -> recover_one`; remote handshake shares `host/headless.rs:212`'s 15 s ready limit.
- Explicit reopen: `lanes/life.rs:665-744 -> start(Some(identity))`; it has the same destructive failure path.
- Queued launch is **fresh**, not resume: `lanes/queue.rs:269-317 -> open_one -> start(None)` (`lanes/mod.rs:1137`); failure resets the queued entry to pending. Cleanup there must own only resources created by that fresh attempt.
- `lanes/mod.rs:1325-1344,1366` sends spec/save/runtime/deadline failures to `start_failed`; `1419-1447` drops the live entry, attempts every recorded worktree removal, discards removal errors, then deletes the lane record.
- `lanes/git.rs:76-82` runs non-forced `git worktree remove` through `rec.place()`, so remote lanes really execute removal on the worker. Unlike normal close, this path never checks unsent work or published files.

### Stock readiness measurements

Three serial launches per size, wall clock from spawn to first `ready`; same isolated profile, normal filesystem cache, shared workstation (not a cold-cache/load-controlled benchmark).
CLI: `omp --mode=rpc-ui --model=fake/primary --no-skills --no-rules --no-context-files --no-extensions --no-title --resume=<absolute-file>`.
Environment cleared except PATH, private HOME/PI_CODING_AGENT_DIR and `PI_NOTIFICATIONS=off`; cwd private. `models.yml` points to `http://127.0.0.1:9/v1`, `api: openai-completions`, `auth: none`.
Generate v3 JSONL: UUID session header with recorded cwd; a linear `id`/`parentId` chain of user messages containing 3,900 text characters each, timestamps included, until the size threshold. No compactions, artifacts or tool payloads.
After ready, `get_state` verified exact ID/path and `get_messages_page(limit=1)` verified the restored message count. Close stdin, drain stdout and reap each process.

| Actual bytes / messages | Ready seconds (all three) | Spawn to first state, seconds |
| --- | --- | --- |
| 201,205 / 49 | 1.1544, 0.4753, 0.4998 | 1.2122, 0.5513, 0.5855 |
| 1,001,290 / 244 | 0.5216, 0.5435, 0.5020 | 0.5959, 0.6105, 0.5700 |
| 5,001,715 / 1,219 | 0.6124, 0.5513, 0.5550 | 0.6877, 0.6520, 0.6326 |
| 20,002,283 / 4,875 | 0.6828, 0.6674, 0.6050 | 0.7824, 0.7617, 0.6985 |

With the 20 MB session, explicit `-e` overrides `--no-extensions`:
- Factory `await new Promise(resolve => setTimeout(resolve, 16000))`: ready **16.7179 s**, state **16.7702 s**.
- Same wait inside `pi.on("session_start", ...)`: ready **0.4336 s**, state **16.4715 s**.
- Every run's first stdout frame was `ready`; no pre-ready progress frame appeared, even during the 16 s factory wait.

The existing stock contract `lead_sleeps_and_wakes_against_stock_omp` passed all five cycles: send-to-live **820, 1279, 955, 1163, 1787 ms**; send-to-model **876, 1418, 1029, 1214, 1866 ms**, same session throughout.
The owner's reported 226 KB alone does **not** explain a 15 s miss; no natural size-only timeout was reproduced, and the owner's actual slow component remains unknown. Sleep since 00:46 alone is not a failed wake: no demand means remaining asleep is correct.

## Why these defects were possible; enforcement boundaries

The structural causes below are demonstrated by the call/data flow, not inferred author intent. Source paths below are under `src/` unless otherwise qualified.

| Failure | Structural root cause | Invariant and enforcing owner |
| --- | --- | --- |
| Slow startup becomes a permanent outage | Transport ready, protocol negotiation and operational binding have separate clocks/errors; the lead's initial-start failure path cannot distinguish delayed initialization from unsafe identity failure. Routine wake inherits that initial-start path. | `host/headless` owns one startup deadline, typed phase and cleanup result; `omp/rpc` accepts its remaining budget; `host/lead` and lane lifecycle classify that result. The exact-bind gate owns permission to flush input. Backoff operates **after** these guarantees, never instead of them. |
| Previous lead becomes invisible | One chronological attempt log also acts as the identity registry. “Intended to resume” and “proven bound” are nullable fields in the same row, and callers independently query the latest row. | Store binding transaction owns the positive resume anchor and retention protection; one target resolver owns pins, fresh intent and verification. `target`, `stored_runtime`, `keep_asleep` and retry all consume its selected identity, never independently pick a latest attempt. |
| Lane/worktree disappears | The shared start routine erases whether it is allocating new resources or reviving an established run; all errors invoke rollback written for a fresh allocation. Removal's Git success is mistaken for preservation proof, and its failure is ignored. | Lane start takes explicit fresh/resume ownership; resume error handling has no deletion capability. A single worktree-removal boundary requires durable close/fresh-rollback authority, quiescence and preservation proof, and records its outcome. No caller may bypass it, including pre-spawn save failure. |
| A retry could duplicate uncertain input | The mailbox treats every search result other than “found” as absence, despite a reader whose result can be incomplete. | Transcript reader returns coverage-aware absence; mailbox alone decides replay from that proof plus process/session identity. Startup supervision never mutates delivery state or emits a prompt. |

The owner's particular OMP slowdown is still unidentified: the allowed evidence disproves a size-only explanation for these synthetic inputs and demonstrates an extension-init cause, but cannot identify an unread owner profile. Do not market a larger timeout or retry as an engine performance fix.

## Root causes

### Startup: a transport milestone is not operational readiness

Stock 19.2.1's bundled public docs, readable with `omp read omp://<name>:raw`, describe:
- `session.md`, “Load and Compatibility Behavior” / “Context Reconstruction”: load JSONL (streaming above 8 MiB), migrate/resolve blobs/index, reconstruct the active branch and model/thinking state. Resume reconstructs context; it does not rerun old tools or replay prompts to inference.
- `sdk.md`, startup/default discovery: settings, auth/model registry, tools and discovery participate; model refresh/prewarming can be background work. RPC skips interactive LSP warmup. Credentials/catalog work is distinct from an inference request.
- `extension-loading.md`, “Module import and factory contract”: module imports and asynchronous factories are awaited. Arbitrary plugin initialization can therefore dominate pre-ready time; the experiment proves this independently of transcript size.
- `mcp-runtime-lifecycle.md`: MCP uses a shared host; the documented startup discovery window is 250 ms, with late tools merged later, not “wait for every server”. No public extension-host-complete startup signal is offered here.
- `rpc.md:31-34`: ready precedes `session_start`; during startup only UI responses and `set_ask_dialog` are processed, other commands wait. Thus ready alone cannot establish usability.

Cataly's `Rpc::connect` waits 15 s for ready, then separately 15 s for `negotiate_protocol` (`omp/rpc.rs:304-369`). A slow startup hook can fail the latter despite timely ready; #299 retries only `Timeout("ready frame")`.
`Session::bind` then starts its clock anew (`host/headless.rs:385,412-416`), so its nominal 30 s “whole start” does not include spawning/ready/negotiation. Stacked clocks, generic failure classification and immediate hold turn recoverable initialization delay into an outage.
Stock offers ready, normal RPC responses and extension events, **not a documented pre-ready progress/remaining-work contract**. Do not infer liveness from stderr, file growth, a lease, bridge hello or arbitrary events. Increasing size is not a valid deadline predictor; repeating a deterministic >15 s initialization with the same bound cannot cure it.

### Lead: attempt history is incorrectly authoritative identity

`store/host.rs:600-610` selects newest role row by `started_ms DESC,rowid DESC`, including unbound attempts.
`lead.rs:657-700` records an attempt before spawn with only `expected_id/file`; `not_started` marks it failed without binding. `plan` receives only this row: unpinned becomes fresh, pinned refuses, and `stored_runtime` also loses the previous identity.
Missing/unverified transcripts also silently select fresh when unpinned (`lead.rs:189-195,765-776`), reproducing the class of failure the owner suffered in 0.1.1. Failure diagnostics, owner intent and the last proven identity are different state.

### Lane: fresh-start rollback is reused for established work

`start_failed` assumes “nothing reached the agent”, which is true only of a particular attempt, not the lane's earlier lifetime. It treats an established run's owned resources as disposable fresh-start allocations. Git's non-forced removal is not an unsent-work proof: it permits unpushed commits and ignored files. Retrying afterwards cannot restore deleted state or ignored bytes.

## Sleep, updates and input safety today

Sleep writes a stopped/asleep record and keeps quiet notes queued (`lead/sleep.rs:145-195`); wake uses the same start path. A pre-bind timeout leaves the owner message and notes pending, not sent or in doubt. Main holds rather than automatically retrying; after another restart, unpinned pending input can go to a fresh conversation as reproduced above.
`cataly update` uses orderly hub stop/start. An already sleeping lead stays asleep; a running lead resumes and can hit this failure. Update success means the new **hub** answers, not that the lead recovered (`cli/install.rs:382-423`); session results are separately reported. No real installer/update was executed.
Written batches remain linked to their original session and marker. Existing rules confirm from the transcript, resend once locally only on the same session after the old process is gone, and leave uncertain remote deliveries in doubt (`host/inbox.rs:645-835`). Startup retries must not create delivery attempts.
Static safety gap: `check` only special-cases `Found::Yes`; read errors/timeouts and a miss in the bounded last 8 MiB can fall through to local resend. “Not observed” is not proven absence (`omp/transcript.rs:433-479`). Preserve the ledger and require complete relevant scan coverage before replay; otherwise hold in doubt. This gap was source-traced, not separately reproduced.

## Proposed invariant and design

### 1. Identity and resource ownership first

- Maintain a durable lead **resume anchor**, separate from append-only launch attempts: proven session ID, canonical file, recorded cwd, runtime and binding provenance. Advance it atomically only after validated binding; a failed attempt never replaces it. Lanes already have this identity in their record: preserve it on every resume failure.
- A configured `session_id` selects that exact previously bound lead identity, even behind newer attempts/other bound sessions; missing, ambiguous or unverifiable means held, never fresh. Use that same selected record for runtime/cwd. Pins win over `--fresh` (refuse the conflict).
- First-ever start may be fresh. An explicit `lead start` retries it when no conversation ever bound; this is never an automatic recovery fallback. After an identity bound, only explicit owner fresh intent permits a replacement. Persist that intent separately: a failed fresh request holds without silently reviving or discarding the previous anchor. No fallback on transcript missing, unsafe, over the supported size limit or unverified; surface the precise check and preserve the files.
- Migrate existing stores from binding evidence ordered by `(started_ms, rowid)`, respecting explicit fresh boundaries; different conversation IDs alone are not ambiguous. Neither is a changed cwd or runtime for the same session file: that is normal history, and the newest binding resumes. Only one session ID recorded with different session files is ambiguous, and it holds only when it is the anchored ID; the owner's plain `lead start` then resumes the anchored file once it verifies, which confirms it. Retain current/pinned anchors and latest evidence per distinct `(session_id, file, cwd, runtime)` tuple independently of the 30-day attempt-history GC. Maintenance may transactionally remove superseded duplicates, never distinct tuples. Prune settled startup receipts only after no surviving binding, anchor, episode or lane references them; unknown ownership is kept.
- **A resume failure may never remove a lane record or worktree.** Mark held/lost with the attempted identity and diagnostics; retain its run, thread, mailbox, goal and worktree ownership. Distinguish `FreshAttempt` resources from `ResumeExisting` before dispatching failure cleanup, including reopen, queued starts and all post-bind/save failures.
- Legacy lanes with no startup receipt and no recorded attempt ownership may resume their saved identity only after a fresh free-lease check. A recorded but unknown attempt never takes that compatibility path.
- Explicit reopen persists `{episode_ms, note, step}` with its run. Hub stop cancels the current attempt; recovery continues the same episode and completed step, never allocating another run or repeating the note. Owner-paused or held lanes with no reopen intent stay down. Preflight refusal leaves the record unchanged; holding an already-held lane preserves its first reason.
- Worktree removal belongs only to an explicit durable completed-close intent, after writers are proven quiescent and a fresh check proves no unsent/unpreserved work, no pending uncertain input, and no published artifact depends on it. Check tracked, untracked **and ignored** content, plus unpushed commits; unreadable/unknown is keep. A failed fresh attempt may remove only its provably new, unused worktree under the same preservation proof. Never force-remove; keep the record and surface removal failure. Explicit destructive owner disposal is a separate operation, not timeout recovery.
- In-doubt input prevents destructive worktree removal, not a safe non-destructive park or close. Keep its ledger and worktree for inspection; never replay uncertain input.

### 2. One bounded startup state machine, on the public protocol

- Proposed default: **60 s hard startup deadline**, measured monotonically from process spawn through ready, protocol negotiation and two matching `get_state` identities. At 15 s emit “still starting existing session”, not failure. This is an operational cap, not a claim all plugins finish within it; owner approval and macOS validation remain required.
- Give startup RPC calls the remaining shared budget, not independent 15 s timers. Keep ordinary post-start command limits. Local/remote starts use the same phase reporting and deadline; lane outer `start_budget` must leave explicit cleanup time rather than dropping the start future halfway through ownership cleanup.
- Readiness means compatible protocol plus exact repeated ID/path and accepted model/thinking, with input fenced until binding is durably committed. Existing extension UI handling must keep draining/responding while startup runs. No OMP patch, internal API, transcript-size formula, fabricated progress, or mandatory disabling of owner plugins.
- Return typed stage/outcome/cleanup evidence. Retry only a classified startup timeout or other explicitly safe transient failure; corruption, identity mismatch, protocol failure, held/unknown lease or unknown cleanup holds immediately. A model mismatch or unverified model follows session-host spec 27: keep the session open and input fenced, do not advance the anchor, and let the owner accept the model explicitly. A model fence prevents idle sleep. A ready-before-hook timeout belongs to startup too, not only the first-frame case.
- Close stdin, continue draining output, then bounded TERM/KILL/reap. Only after verified previous-attempt termination **and** a fresh free-lease check may the same exact identity retry. Remote EOF is not a reap receipt: obtain worker-side attempt exit acknowledgement/reconciliation; disconnect with unknown ownership holds.
- Persist enough pre-bind attempt ownership to reconcile hub crashes (process identity/start identity or worker attempt token); PID currently arrives only at binding. A free OMP lease alone is insufficient: stock claims a lease on writing, so a still-initializing orphan may not hold it yet. Serialize starts and retain the final exact-identity fence against lease-check races.
- Reuse #299's 1/2/4/8/16 s backoff and five-retry ceiling, adding a **300 s total recovery-episode cap** including cleanup/waits. Persist the episode/attempt accounting across hub restarts; longer per-attempt limits must not let a rolling window retry forever. Stop/shutdown/target changes cancel scheduled retries and await owned cleanup. No input is resent merely because another launch was attempted.

### 3. Delivery and owner visibility

- Keep queued owner messages and quiet notes untouched until the anchored session is bound. Successful wake flushes once; resume notes retain their once-only identity. Restoring an asleep anchor with quiet notes alone does not wake it.
- Reconcile prior sent batches before new input: marker found => delivered; confirmed old-process exit + same identity + proven complete absence => at most the existing one resend with the original delivery ID. Unknown/truncated/unreadable evidence => in doubt; remote uncertainty never automatically replays. Retrying must never reset a delivery's resend bit or once-ID state.
- Expose target ID/path, startup phase/elapsed time, attempt count/next retry, cleanup/lease evidence and pending/in-doubt counts in status/health. Notify the owner directly on prolonged recovery and once on terminal hold; the unavailable lead cannot be the sole notification route. Explain that conversation/work is retained and how to retry after correcting the cause, not suggest fresh as repair.
- Updates distinguish “hub updated; sessions recovering” from “resumed”/“held”; their one-minute summary wait must not label a pending retry final. Emit the eventual result. Lanes preserve active/paused goal intent and do not replay kickoff on resume; cap offline queued-launch failures separately from reconnect recovery.
- Answer-triggered goal resume is headless-only, requires owner/lead input and excludes owner-held lanes, pending reopen and in-doubt input. Tern cannot prove pause provenance, so it remains paused and reports explicit terminal or `lane.pause`/`lane.resume` recovery. Reminders and budget blocks never resume a goal.

## #299 review verdict

Useful, scoped contribution: it fixes the demonstrated unbound-failed-resume selector case, carries cleanup exit evidence, checks leases before retries, bounds the existing short retries, serializes start/stop and cancels scheduled retries at shutdown. Its two added tests cover transient recovery, same-file delivery and shutdown during backoff; no obvious new pending-input double-send appears in that path.
It does **not** fix arbitrarily slow initialization with repeated 15 s limits, post-ready startup-hook timeouts, missing/unverified transcript fallback, older explicit pins, anchor retention, fresh-attempt barriers, remote reap evidence, or destructive lane rollback. The skipped-row predicate is a special case, not the positive “proven identity” invariant. Existing mailbox absence uncertainty also remains.
Within its current ~15 s attempts the five-in-ten-minute limiter terminates a persistent ready failure; do not describe this PR as retrying forever. A longer generalized deadline needs an absolute episode cap. Lease checks are necessary but not an atomic reservation or orphan-process proof.
**Recommendation:** fold its selector/reaping/serialization/backoff work into the root-cause implementation with Momentum96 credited; keep review credit and tests, but expand them before approval. PR product code was reviewed, not applied or executed in this design-only worktree.

## Implementation slices and acceptance

Sizes are review scope, not promises of elapsed time. Implement only after owner approval.

1. **S/M — stop destructive lane rollback first:** separate fresh allocation rollback from resume failure; preserve records/worktrees on local recovery, reopen and remote reconnect. Tests reproduce all six worktree cases above and assert preservation, including ignored files and failed cleanup receipts; queued fresh launches must never claim another run's resources.
2. **M — durable identity:** anchor/binding migration, pin precedence, explicit fresh intent, runtime/cwd selection, safe retention. Table/store tests: failed resume/fresh, pre-bind hub death, older pinned identity, missing/unverified/oversized transcript, equal timestamps, 30-day retention, asleep anchor with quiet notes.
3. **M/L — startup/cleanup supervisor:** shared absolute deadline, typed phases, bounded persistent retry, cancellation, remote exit evidence. Wire tests: just-under/over deadline, delayed factory versus delayed session_start, EOF/wrong protocol/identity mismatch, held/unknown lease, unknown reap, shutdown/backoff/stop races, and crash before binding without a lease. No test may accept a fresh substitute.
4. **M — delivery and reporting:** full-scan absence authority, pending/quiet/sent/in-doubt cases, partial transcript reads and old marker outside 8 MiB, exhaustion notification, update “recovering” summary. Sleep-wake timeout must recover A, deliver the owner message plus quiet notes once, then sleep again; also exercise repeated failure and pinned hub restart.
5. **S — real-contract gate and docs:** rerun `tests/lead.rs`, affected lane/worker tests and `tests/contract_session.rs` against stock OMP on Linux/macOS, with generated larger/branched/artifact-bearing sessions; update session-host/lane specs, config and changelog. Measure ready separately from bound and message-to-model latency.

Investigation runs: `CARGO_TARGET_DIR=target/chk-lresume cargo test --test lead_resume_investigation ...` (three lead sequences, stock delayed-factory timeout, lane deletion); `--test worker_resume_investigation resume_cleanup_worktree_evidence` (six cases); and `CATALY_CONTRACT_OMP=1 CATALY_CONTRACT_OMP_PATH=/home/turing/.bun/bin/omp ... --test contract_session lead_sleeps_and_wakes_against_stock_omp -- --nocapture --test-threads=1` (passed). Throwaway test/scripts are removed, not committed; the procedures and all measurements are retained here.
Not measured: owner's plugins/accounts/storage/load, natural >15 s resume, macOS timings, real-network worker latency or an actual installer switch. These are not evidence that the owner's report is wrong.

## Owner decisions

Approve fail-closed resume (including unpinned missing/unverified files) and the lane-preservation slice as highest priority?
Approve the proposed 15 s notice / 60 s startup / 300 s recovery cap, or prefer another explicit operational limit?
On failed explicit fresh intent, keep the old conversation recorded but held until the owner chooses retry-fresh or resume-old?
Keep ignored files by default on completed close, with any cache-disposal policy separately explicit? This investigation proves non-forced Git removal alone is insufficient.
