# GVSI NetPulse — Auth Notes

The client has always sent an identity. Until P1 Phase 1 the **server never
verified one** — every `doGet` action was open to anyone holding the deployment
URL, and `handleSetMaintenance` wrote `e.parameter.admin` straight into the
`AppSettings` sheet. Anyone could flip maintenance mode *and* forge the audit
trail. This file explains what replaced that, and how to move it forward.

Read this before touching `doGet`, `handleLogin`, or anything that decides who a
caller is.

---

## 1. The model

```
login  ──► handleLogin()  ──► issueSessionToken(u, name, role)
                               │
                               └─ PropertiesService: session_<token> = {u, name, role, exp}
                                          │
every gated call ──► requireSession(e, role) ──► readSessionToken(?token=)
                                                    ├─ missing / expired / corrupt → delete, reject
                                                    └─ valid → proceed, identity = the TOKEN
```

- **Identity comes from the token, never the URL.** `UpdatedBy` is `session.u`;
  `handleHeartbeat` ignores `?username=`/`?fullName=` whenever a session exists,
  so a valid login cannot register somebody else as active.
- **Token = `getUuid()` + a dash-stripped second `getUuid()`.** One UUID is 122
  random bits but the values are close to sequential in practice, and a
  predictable token is a guessable one.
- **TTL is 24 h, matching the client's `SESSION_DURATION`.** The token therefore
  never dies mid-shift while the client session is still valid. They expire
  together.
- **No rotation, no refresh.** The token is valid for its full TTL or until
  logout. A sliding refresh on heartbeat is the natural Phase 2 addition.

## 2. The one asymmetry that matters — and its history

`requireSession()` treats the two failure shapes **differently on purpose**:

| Incoming state | Phase 1 (`REQUIRE_SESSION = false`) | **Phase 2 — current (`true`)** |
|---|---|---|
| No token at all | allowed, so an old cached shell keeps working | **refused** |
| Token present but invalid/expired/unknown | rejected, always | refused |

A forged or expired token could **never** be accepted, in either phase — only the
*absence* was ever tolerated, and only while the rollout was in flight.

**We are in Phase 2.** The switch was flipped on 2026-09-12, after the token path
was verified against the deployed backend (a real login issued a token, and a
role-gated route accepted it). Phase 1 existed so the backend could be deployed
before every client had the new shell; keeping the constant as a named switch
means the history is auditable and one line can revert it.

**Consequence to know:** a client holding a session from *before* the flip has no
token, so its gated calls are now refused. Data routes and the kiosk are
unaffected; the admin panel shows the "Session expired" prompt and the user signs
in again, which mints a token. That is the designed recovery path, not a breakage.

## 3. Gated routes

| Route | Gate | Notes |
|---|---|---|
| `login` | public | returns `token`; throttled |
| `logout` | token optional | revokes; idempotent — an unknown or absent token still answers `{success:true}` so a logout can never fail loudly |
| `keepalive`, `getSettings` | public | `getSettings` returns only `{maintenance}` and is called *before* login |
| `setMaintenance` | admin role | `UpdatedBy` from the token |
| `getActiveUsers` | admin role | |
| `heartbeat` | any valid session | identity from the token |
| `removeActiveUser` | any valid session | self always; another user requires admin |

**Data routes (`?type=`) are deliberately untouched.** Gating them would make a
stale token blank the kiosk, and the intended change here is only the four write
paths that can break the system or lie in the audit trail.

## 4. Login throttling

`sha256()` is a single unsalted round, so the only real defence against a
guessing loop is to stop accepting guesses.

- **5 failures → 5-minute lockout**, checked *before* the sheet read and the
  hash, so a locked-out attempt does no work at all.
- Each failure sleeps `400 ms × attempts`, capped at 2 s. Best-effort: a failed
  `Utilities.sleep` never breaks the response.
- The counter **resets to 0 once a lockout lapses**, so one further typo does not
  instantly re-lock someone who just waited the window out.
- Any successful login clears the counter.
- The failure message stays generic, so responses cannot enumerate usernames.

## 5. Traps — read before changing anything here

1. **Never sweep `PropertiesService` without a prefix.** `session_*` shares the
   property store with the oversized-payload cache (`cache_v2_*`).
   `pruneExpiredTokens()` filters on the prefix for exactly this reason; an
   unfiltered delete loop would silently destroy a module's cache.
2. **Anything new in `PropertiesService` needs a prune rule.** Tokens accumulate
   otherwise — the same class of bug as the never-expiring payload cache.
3. **A token rejected on read is deleted, not retried.** Same discipline as "a
   missing stamp counts as expired" in the caching notes: a bad entry must not
   be able to resurrect itself.
4. **Use `var`, not `let`/`const`, for anything the early boot path touches.**
   `fetchWithRetry` can run before the auth constants block executes, and a
   `let` there throws in its temporal dead zone — this already caused one real
   bug (see the caching notes).
5. **Nothing reads `?admin=` any more.** The server takes `UpdatedBy` from the
   token only, and the client no longer sends the param. Do not reintroduce a
   URL-supplied actor "for convenience" — that was the original forgery hole.
   With no token there is no trustworthy actor, so the value is written as
   `unknown` rather than guessed.
6. **`REQUIRE_SESSION` is the single switch.** Do not scatter `if (token)`
   checks through the handlers; they will drift apart.

## 6. Debugging

| Symptom | Look at |
|---|---|
| Everyone gets bounced to login | deployed backend missing the `logout`/token code, or the token TTL is shorter than the client session |
| Admin actions fail with "role does not allow" | the token's `role` vs `ADMIN_ROLE` (`Tech admin/Dev`) — `issueSessionToken` copies it from the `Users` sheet |
| A user is stuck in `ActiveUsers` | heartbeat now requires a token; a request with **no** token is still fine in phase 1, an *invalid* one is not |
| Logins refuse with "Too many failed attempts" | `loginfail_<username>` in script properties; a lockout lapses after 5 min |
| A token is accepted after logout | check the `logout` action is routing (one line in `code.gs`) |
| The admin panel suddenly asks everyone to sign in | expected if a session predates the Phase 2 flip — it has no token; one re-login fixes it |
| A heartbeat is silent but the user never appears in `ActiveUsers` | that client has no token, so the beat is refused. Heartbeats fail silently by design; the admin panel's Active Users call is what surfaces the prompt |

## 7. What this is not

- **Reads are still open.** Anyone with the deployment URL can read outage data.
- **The token travels in the query string.** Apps Script only exposes
  `e.parameter`, and a JSON `doPost` body triggers a CORS preflight the
  deployment does not answer — so the token can surface in browser history and
  `Referer`.
- **The password layer is unchanged.** `sha256()` remains single-round and
  unsalted, and `netpulse_remember` still stores the plaintext password. That is
  the P2 item, not this one.

Track the remaining work in `todo.md`.
