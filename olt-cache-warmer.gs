/**
 * ==================== OLT CACHE WARMER ====================
 *
 * Pre-builds the OLT cache on a 15-minute trigger (the same cadence as the
 * aging writer), so user requests hit CacheService instead of the 11-25 s
 * cold-build path. The trigger is registered by setupAllTriggers() in
 * triggers.gs.
 *
 * Why 15 minutes: the OLT aging data is written on the same cadence by
 * updateAgingDurationStatic(), so a 16-minute warm window loses no freshness —
 * the cache is refreshed after every aging write.
 *
 * The warmer calls doGet() directly with shape=3 (problem-only compact
 * payload) to build both the primary cache entry and the compact-keyed entry
 * in one pass. A normal user request that hits the cache returns in <200 ms.
 */
function warmOltCache() {
  // Build the problem-only compact payload (shape=3)
  var fakeEvent = {
    parameter: { type: 'olt', shape: '3' }
  };

  var start = Date.now();
  try {
    var output = doGet(fakeEvent);
    var elapsed = Date.now() - start;
    var content = output.getContent();
    var size = content ? content.length : 0;

    Logger.log('✅ warmOltCache: OLT cache warmed in ' + elapsed + 'ms (' + size + ' bytes)');
  } catch (err) {
    Logger.log('❌ warmOltCache failed: ' + err.message);
  }
}
