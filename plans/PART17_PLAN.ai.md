@PlannablePlan v0.1

Part: PART-017 — the spare attempts are for blips, not for stalls
Project: GVSI NetPulse
Phase: 9 (what a stalled deployment does to a retry policy)

DICT
  attempt      = one call to fetch() inside fetchWithRetry(): one request, one response
  blip         = a failure the origin was not responsible for and that a second attempt
                 usually clears: a dropped connection, a 500 from the edge, a half-written
                 body. Normally sub-second, and always cheap to retry
  stall        = the DEPLOYMENT answering slowly or not at all. Measured from outside as
                 Apps Script's 8 KB error page after 7.5 s, 16.0 s and 30.8 s, and once as a
                 redirect chain that outlived a 40 s cap. It hits whichever request is in
                 flight — `?action=rev`, one property read, took 16.0 s inside one
  stall rule   = a FAILED attempt that consumed >= 5 s ends the retry loop: the remaining
                 attempts are not spent on it

G
  A stalled deployment stops being made worse by the app: the retry that was fired 250-750 ms
  after a 30 s stall — inside the same stall, guaranteeing a second full stall — is no longer
  fired, and the console says the budget was cut short instead of looking like a budget that
  ran out.

CTX
  - The measurements that produced this part, taken from OUTSIDE the deployment on
    2026-09-26 with curl, because `?action=diag` needs an admin token and none is available:
      hit path 1.06-1.48 s across 15 module requests; successful cold builds 2.9-3.2 s;
      failures 7.5 s, 16.0 s, 30.8 s (all the 8 KB error page) and one 302 chain > 40 s.
  - A retry only helps if the condition has cleared by the time it fires. The backoff here is
    delay * 2^i * jitter = 250-750 ms for the first retry, against a stall that lasted at
    least 30 s and cleared within 60 s. Four consecutive OLT requests inside one stall window
    all failed; the same request 60 s later answered in 1.48 s.
  - Waiting the stall out inside the request is not available either: fetch-gate's ceiling is
    30 s (TIMEOUT_MS), which is shorter than the stall it would have to wait through.
  - `retryable:true` is the origin asking for a retry BY NAME — `{error:"build_failed",
    retryable:true}` from code.gs's build guard. It arrives at build duration, i.e. inside the
    stall window, so a naive duration threshold would swallow the one failure that asks to be
    retried. Envelopes are therefore excluded from the rule entirely.
  - What was NOT indicted, and this matters as much as what was: every module answered on the
    hit path in 1.06-1.40 s. No module is slow. `?type=olt&shape=3` returning 216 bytes with
    `p`, `m`, `r` all empty is CORRECT, not broken — shape=3 is problem-only by design, and
    all 461 OLTs were UP. The stack is live: `?action=bundle` answers 3607 bytes in 1.18 s,
    `?action=diag` is gated and answers in 1.54 s, `?action=rev` in 1.83 s.
  - Last night's `?action=bundle` 404 and `?action=keepalive` 404 were the same stall, not a
    missing paste. `?action=definitelynothere` answers `{"error":"Unknown action: ..."}` in
    1.71 s, so the dispatch is reachable and the route table contains bundle.

C
  - CLIENT ONLY. No server byte, no new request, no new query parameter, no worker redeploy.
  - THE ORIGIN'S OWN INSTRUCTION OUTRANKS ANY THRESHOLD. `envelope: true` on both envelope
    kinds; the rule tests that flag, not the status code.
  - A STALL IS NEVER BLAMED FOR A WRONG REQUEST. `retryable:false` and a slow deployment can
    happen at once, so a fatal envelope is reported for its own reason.
  - THE REPORT SAYS WHY THE BUDGET WAS SHORT. "Failed after 1 attempt" alone is
    indistinguishable from a budget that ran out; the message carries `origin stalled
    30800ms, budget not spent` and the console warning says `stalled, not retrying`.
  - THE THRESHOLD IS DERIVED, NOT CHOSEN. 5000 ms sits above the slowest SUCCESSFUL attempt
    ever measured here (3.23 s) and below the fastest failing one (7.5 s).
  - The release label moves (client bytes changed). The guard does not.

F
  index.html                       STALL_MS with its arithmetic, attemptStartedAt, stalledAt,
                                   the envelope marker, the stall rule, the warning and the
                                   report; the release tokens
  tests/origin-resilience.test.js  a controllable clock in clientHarness (a response states
                                   its own duration), and four cases — the 30.8 s stall, the
                                   4999/5000 boundary, an envelope that asks to be retried,
                                   and a fatal envelope that happened to be slow
  sw.js                            the cache generation
  plans/PART17_PLAN.ai.md          this artifact
  MASTER_PLAN.md                   Part 17, SCN-020
  PLAN_EVIDENCE.md                 PART-024
  TODO.md                          the paste/push list, and the diag report still unread
  .freebuff/run.md                 the external probe recipe and the stall rule

T
  1. STALL_MS, derived from the live numbers and written where the retry policy is read.
  2. The per-attempt clock, so a failure can say how long it took to arrive.
  3. The envelope marker, and the rule that reads only that flag.
  4. The honest report and warning at both exits.
  5. The four cases, with a clock that can stand in for 30 s without waiting for it.
  6. Version bump 3.9.22 -> 3.9.23, guard untouched at 3.10.0.

VALIDATION
  - A failing attempt that consumed 30800 ms stops at ONE request, the message carries
    `origin stalled 30800ms`, and the recorded sample says `attempts: 1` — the card must not
    claim two attempts that never happened.
  - The boundary is pinned on both sides: 4999 ms still gets three attempts, 5000 ms gets one.
  - An envelope with `retryable:true` at 8000 ms still gets three attempts and is not
    reported as a stall.
  - A `retryable:false` envelope at 8000 ms gets one attempt and is not reported as a stall.
  - Everything that was already true stays true: the fast 404 still spends three attempts,
    the non-JSON body is still a failure, a transient failure still recovers inside the
    request, the backoff is still bounded and jittered, one success still records one sample.
  - Mutation pass on a green baseline: every one of the ten caught. Two earlier mutations were
    NOT caught and both were correct findings — `envelopeErr.retryable` was redundant beside
    `fatal` (replaced by the single `envelope` flag, which is observable), and no test
    asserted the warning's presence (added).
  - From outside, before and after: time `?action=rev` (one property read) against
    `?action=bundle` (3607 bytes, one cache read) against `?type=olt&shape=1` (461 rows). A
    module that is slow shows up as a module; a deployment that stalls shows up as all of them.

DONE
  Built, tested and mutation-checked in the repo, 2026-09-26. 20 suites, 389 cases, 0 failed
  (385 -> 389). 10 mutations for this part, every one caught.

  Recorded and NOT fixed, because the evidence does not indict it:

    - The live `?action=diag` report was never read. It needs an admin token, there is no
      credential in the workspace, and the login route has a lockout, so the substitute was to
      measure the same things from outside. The one line that would produce it is in TODO.md.
    - The 21 s origin 404 is the same family as the stalls measured here (7.5 s, 16.0 s,
      30.8 s, > 40 s) and is still open. What is new is that the number is no longer anonymous.
    - `?action=keepalive` was seen failing once, at night, in the same window as everything else.

  - No module was fixed, because no module was indicated: 15 module requests on the hit path,
    all 1.06-1.40 s.
