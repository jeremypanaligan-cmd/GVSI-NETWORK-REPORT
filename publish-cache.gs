// ====================== EDGE PUBLISH — the server half of the edge read path ======================
//
// WHAT THIS FILE IS FOR
//
// Every module read used to pay Apps Script's fixed cost in full: ~1.2-1.8 s warm, plus the
// 302 -> script.googleusercontent.com hop, plus the ~20% 404 tail measured during a stall, plus
// one quota-spending execution per request. None of that is about the payload — the payload is
// 0.5-50 KB. This file makes the trigger the ONLY writer of a copy that already exists, and
// hands the read to the edge: the app fetches tens of milliseconds after this publishes.
//
//   trigger (every 5 min)                      browser
//     doGet(type) -> build                       |
//     cache.put(...)                             |  GET /data/nap   ~30-100 ms
//     publishBuiltPayload_()  ---> KV <----------+  (Authorization: Bearer <login token>)
//
// A failed read falls back to /exec exactly as before, so this can never be the reason a screen
// goes blank. The switch on the client side is one value (window.NETPULSE_CDN); blank = today.
//
// WHERE IT IS WIRED IN
//
// olt-cache-warmer.gs calls publishBuiltPayload_() at the two points where a build has already
// been judged a SUCCESS — warmOltCache() and warmTypeCache_() — so a failed build is never
// published, from the same evidence the warm pass counts.
//
// admin.gs adds `cdnToken` to the login response (edgeTokenForLogin_), which is the short-lived
// HMAC the edge verifies. A deployment without this file simply omits the field, and the client
// falls back to /exec for every read — the pre-existing behaviour, not a broken login.
//
// THE THREE PROPERTIES (Script Properties; run setEdgeConfig_ once from the editor)
//
//   netpulse_worker_url           e.g. https://holy-cloud-1d7a.jeremysamsonpanaligan.workers.dev
//   netpulse_publish_secret       matches PUBLISH_SECRET in the Worker settings
//   netpulse_read_secret          matches READ_SECRET in the Worker settings
//
// The secrets exist in TWO places and in NO repository. They are pasted, not committed: this
// repo has already leaked a key once, and the deploy URL lives in fewer places for the same
// reason.
//
// WHAT IT REFUSES TO PUBLISH
//
//   - an ERROR ENVELOPE. {error:"build_failed"} parses perfectly, so it would be stored, served
//     and drawn as an empty table on every screen in the fleet until the next successful run.
//     The worker refuses it too; both refuse it because either half might be the one that is
//     older. An EMPTY payload is published: that is how the OLT zero state and the NAP/LCP
//     "no pending" screens are drawn.
//   - anything when the properties are absent. A quiet, once-per-execution note says so, and
//     every module keeps loading through /exec.
//
// FAIL-OPEN, ALWAYS
//
// Every exit of publishBuiltPayload_ is a return. A worker that is down, an HTTP refusal, a
// thrown UrlFetchApp — all logged, all swallowed, and the edge simply keeps serving the last
// payload it was given (with the honest age the chip already reports). Nothing here can delay a
// build or break a read.
//
// ONE COPY OF THE BYTES, NOT A SECOND SHAPE
//
// What is published is the exact JSON string the build produced and cached, so a payload read
// from the edge and a payload read from /exec are the same bytes. Two shapes for one module is
// how this app has already shipped a "the table and its cards disagree" bug.

var EDGE_PROP_URL = 'netpulse_worker_url';
var EDGE_PROP_PUBLISH_SECRET = 'netpulse_publish_secret';
var EDGE_PROP_READ_SECRET = 'netpulse_read_secret';

/* Matches the client's session lifetime: a token that outlives the session it was minted for
   would let a shut laptop keep reading with a credential nobody is watching. */
var EDGE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/* There is deliberately no request timeout constant: classic UrlFetchApp has none to give the
   caller, and the script's own runtime limit is the ceiling. The edge answers in tens of
   milliseconds, and a worker that is down fails by DNS or by connection, not by hanging — so a
   number here would be a comment pretending to be a safeguard. */

/* Per execution (Apps Script resets module state every run), so a worker that is down produces
   one line per warm pass rather than one per module. */
var _edgeNoteLogged = false;
var _edgeFailureLogged = false;

function edgeScriptProperties_() {
  return PropertiesService.getScriptProperties();
}

function readEdgeConfig_() {
  var props = edgeScriptProperties_();
  return {
    url: String(props.getProperty(EDGE_PROP_URL) || '').replace(/\/+$/, ''),
    publishSecret: String(props.getProperty(EDGE_PROP_PUBLISH_SECRET) || ''),
    readSecret: String(props.getProperty(EDGE_PROP_READ_SECRET) || '')
  };
}

/**
 * Write the three properties from the editor, once:
 *
 *   setEdgeConfig_('https://<worker>.workers.dev', '<publish secret>', '<read secret>');
 *
 * Deliberately a function rather than documentation: the Apps Script Properties UI is where a
 * trailing space or a pasted quote goes unnoticed, and a secret with a trailing space fails as a
 * 401 nobody can explain.
 */
function setEdgeConfig_(workerUrl, publishSecret, readSecret) {
  var props = edgeScriptProperties_();
  props.setProperty(EDGE_PROP_URL, String(workerUrl || '').trim().replace(/\/+$/, ''));
  props.setProperty(EDGE_PROP_PUBLISH_SECRET, String(publishSecret || '').trim());
  props.setProperty(EDGE_PROP_READ_SECRET, String(readSecret || '').trim());
  var cfg = readEdgeConfig_();
  Logger.log('✅ edge config written: url=' + (cfg.url || '(empty)') +
             ', publishSecret=' + (cfg.publishSecret ? 'set' : '(empty)') +
             ', readSecret=' + (cfg.readSecret ? 'set' : '(empty)'));
}

/* Web-safe base64 with the padding REMOVED, so a token has one canonical form.

   MEASURED, not assumed: the worker's decoder re-pads from the length it is given, so it accepts
   a padded token as well — the strip is not what makes verification work. What it buys is that a
   token this half minted and a token the worker's own test minted are the SAME string, which is
   the only way the two can be compared when something is wrong. The worker's leniency is
   deliberate and tested: the two halves are separate pastes, and a mismatched pair must fail on
   the signature, not on a trailing '='. */
function edgeBase64Url_(value) {
  return Utilities.base64EncodeWebSafe(value).replace(/=+$/, '');
}

/**
 * The read token the edge verifies: `b64url(username|exp) . b64url(hmac)`.
 *
 * The subject travels INSIDE the token because a signature over an unseen payload cannot be
 * checked by a worker that never calls Apps Script — which is the whole point of moving the read
 * off Apps Script.
 *
 * @return {string} the token, or '' when no read secret is configured
 */
function mintEdgeToken_(username, expMs) {
  var cfg = readEdgeConfig_();
  if (!cfg.readSecret) return '';

  var subject = String(username || '') + '|' + String(expMs);
  var signature = Utilities.computeHmacSha256Signature(subject, cfg.readSecret);
  return edgeBase64Url_(subject) + '.' + edgeBase64Url_(signature);
}

/** The token for a login that just succeeded. '' when the edge is not configured. */
function edgeTokenForLogin_(username) {
  return mintEdgeToken_(username, Date.now() + EDGE_TOKEN_TTL_MS);
}

/**
 * Publish one built payload to the edge.
 *
 * Called from olt-cache-warmer.gs immediately after a build has been judged a success.
 *
 * @param {string} type  a member of DATA_TYPES in code.gs
 * @param {string} json  the exact response body that was just cached
 * @return {boolean} whether the edge accepted it — never throws, never blocks a build
 */
function publishBuiltPayload_(type, json) {
  var cfg = readEdgeConfig_();

  if (!cfg.url || !cfg.publishSecret) {
    if (!_edgeNoteLogged) {
      _edgeNoteLogged = true;
      Logger.log('ℹ️ edge publish is not configured (' + EDGE_PROP_URL + ' / ' +
                 EDGE_PROP_PUBLISH_SECRET + ') — every module still reaches /exec exactly as before');
    }
    return false;
  }

  if (typeof json !== 'string' || !json.length) return false;

  /* The same refusal the worker makes, made here first and for a different reason: this half
     knows what a failed build looks like, and asking the worker to reject it would spend a
     request to learn something already known. */
  if (typeof isBuildErrorEnvelope_ === 'function' && isBuildErrorEnvelope_(json)) {
    Logger.log('⏭️ edge publish skipped for ' + type + ': the build answered an error envelope');
    return false;
  }

  /* THE AGE THE CHIP REPORTS. This is the moment the payload was produced, not the moment a
     reader asks for it — carried as metadata, so the freshness chip can say "Data as of 09:12"
     about bytes it did not just fetch. */
  var builtAt = Date.now();
  var rev = (typeof dataRevOf_ === 'function') ? String(dataRevOf_(type)) : '';

  var url = cfg.url + '/publish?type=' + encodeURIComponent(type) + '&builtAt=' + builtAt +
            (rev ? '&rev=' + encodeURIComponent(rev) : '');

  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: json,
      headers: { 'x-netpulse-secret': cfg.publishSecret },
      // A refusal is a body to read, not an exception to catch: an HTTP status here must not
      // look like a thrown error in the executions log.
      muteHttpExceptions: true,
      followRedirects: true
    });

    var code = response.getResponseCode();
    if (code !== 200) {
      if (!_edgeFailureLogged) {
        _edgeFailureLogged = true;
        Logger.log('⚠️ edge publish failed for ' + type + ': HTTP ' + code + ' — ' +
                   String(response.getContentText() || '').slice(0, 200) +
                   (code === 401 ? ' (the publish secret does not match PUBLISH_SECRET in the worker)' : ''));
      }
      return false;
    }
    return true;
  } catch (err) {
    if (!_edgeFailureLogged) {
      _edgeFailureLogged = true;
      Logger.log('⚠️ edge publish threw for ' + type + ': ' + err.message +
                 ' — the edge keeps serving the last payload it was given');
    }
    return false;
  }
}

/**
 * What the edge currently holds, as a human would see it. Read-only, manual, and the fastest way
 * to answer "did the last pass actually publish?" without opening the Cloudflare dashboard.
 *
 * Logs one line per type. Returns a summary object so a caller can assert on it.
 */
function reportEdgeState() {
  var cfg = readEdgeConfig_();
  if (!cfg.url || !cfg.readSecret) {
    Logger.log('ℹ️ edge state unavailable: ' + EDGE_PROP_URL + ' / ' + EDGE_PROP_READ_SECRET + ' are not set');
    return { configured: false };
  }

  var token = mintEdgeToken_('diagnostics', Date.now() + 60000);
  try {
    var response = UrlFetchApp.fetch(cfg.url + '/data/_meta', {
      headers: { authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    Logger.log('edge /data/_meta: HTTP ' + response.getResponseCode() + ' — ' +
               String(response.getContentText() || '').slice(0, 600));
    return { configured: true, code: response.getResponseCode(),
             body: String(response.getContentText() || '') };
  } catch (err) {
    Logger.log('⚠️ edge state threw: ' + err.message);
    return { configured: true, code: 0, error: err.message };
  }
}
