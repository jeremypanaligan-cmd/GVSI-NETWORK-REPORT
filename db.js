// ====================== IndexedDB MODULE ======================
// Offline-first data storage para sa daily snapshots & trend charts

const DB_NAME = 'netpulse-db';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const RETENTION_DAYS = 90;

// The five module caches a snapshot is built from.
const SNAPSHOT_MODULES = ['nap', 'lcp', 'olt', 'node', 'backbone'];

/**
 * Module caches that have not been FILLED yet. `null` means "no successful load":
 * none of the five fetchers writes its own cache on its error path.
 *
 * This is deliberately NOT the question "has the fetch settled". A fetch that
 * fails settles too, so triggering on settlement alone still records that module
 * as zero — and because only the FIRST snapshot of each day is kept, that zero
 * then stands for the rest of the day.
 *
 * Observed live on 2026-09-13: two Apps Script /exec 404s (its documented
 * transient stall; retried and still exhausting the budget) produced a snapshot
 * reading `olt: { total: 0 }` against 461 real OLTs and `backbone: { tickets: 0 }`
 * against 7.
 *
 * A module that loaded and genuinely found nothing is NOT missing — node and
 * backbone set `[]`, lcp sets an object — so real empty data passes this check.
 */
function unloadedModules(cache) {
  return SNAPSHOT_MODULES.filter((k) => cache[k] === null || cache[k] === undefined);
}

// One successful write per page session. The date check inside saveDailySnapshot()
// is a read followed by a much later write, so two boots in one session can both
// see "no record yet" and both write — which is precisely what the console showed:
// "[IndexedDB] Snapshot saved for 2026-09-13" logged twice. Set only on a real
// write, so a skipped attempt leaves the day open for a later, complete one.
let _snapshotWritten = false;

// Open database
//
// The connection is opened once and reused. It used to open a brand-new
// connection on every call (saveDailySnapshot calls this twice, and analytics
// calls it on every render) without ever closing one — so connections piled up
// and an external deleteDatabase could never release the database.
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'date' });
      }
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      // Release the connection when another context (or our own purge entry
      // point in cache-control.js) wants to delete or upgrade the database.
      // Without this the delete request sits pending forever.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = (e) => { dbPromise = null; reject(e.target.error); };
  });
  return dbPromise;
}

// Close the shared connection so the database can be deleted or upgraded.
// Safe to call when nothing is open. Used by netpulseCache.clearIndexedDB().
function closeDB() {
  if (!dbPromise) return Promise.resolve('no open connection');
  const pending = dbPromise;
  dbPromise = null;
  return pending.then((db) => {
    try { db.close(); } catch (e) { /* already closed */ }
    return 'connection closed';
  }).catch(() => 'no open connection');
}

// Save daily snapshot (one per day). Returns true only when it actually wrote.
async function saveDailySnapshot() {
  if (_snapshotWritten) return false;

  try {
    // Refuse to record a module that never loaded — see unloadedModules(). Skipping
    // costs nothing: the day is still empty, so the next successful load writes it.
    // Writing a partial snapshot is the part that cannot be undone.
    const missing = unloadedModules(dataCache);
    if (missing.length) {
      console.log('[IndexedDB] Snapshot skipped — not loaded yet:', missing.join(', '));
      return false;
    }

    const today = new Date().toISOString().slice(0, 10);
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    // Check kung may today's snapshot na
    const existing = await new Promise((resolve) => {
      const req = store.get(today);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    if (existing) { _snapshotWritten = true; return false; } // Already saved today

    // Gather data from all module caches
    const napData = dataCache.nap || [];
    const lcpData = dataCache.lcp || {};
    const oltData = dataCache.olt || [];
    const nodeData = dataCache.node || [];
    const bbData = dataCache.backbone || [];
    const lcpAging = lcpData.lcpAging || [];
    const lcpImpact = lcpData.lcpImpact || [];

    // Calculate metrics
    let napTotal = 0, napCritical = 0;
    napData.forEach(r => { if ((r.A || '').toUpperCase() !== 'TOTAL') { napTotal += parseInt(r.T) || 0; napCritical += parseInt(r.D3) || 0; } });

    let lcpTotal = 0, lcpClients = 0;
    lcpAging.forEach(r => { if ((r.A || '').toUpperCase() !== 'TOTAL') lcpTotal += parseInt(r.T) || 0; });
    lcpImpact.forEach(r => { lcpClients += parseInt(r.C) || 0; });

    let oltUp = 0, oltDown = 0, oltLowPower = 0, oltUplinkDown = 0, oltDegradation = 0, oltClientsDown = 0;
    oltData.forEach(item => {
      const st = (item.S || '').toUpperCase();
      if (st === 'DOWN') { oltDown++; oltClientsDown += parseInt(item.CA) || 0; }
      else if (st.includes('LOW POWER')) oltLowPower++;
      else if (st.includes('UPLINK DOWN')) oltUplinkDown++;
      else if (st.includes('DEGRADATION')) oltDegradation++;
      else oltUp++;
    });

    let nodeTickets = nodeData.length, nodeEquipment = 0;
    nodeData.forEach(item => { nodeEquipment += parseInt(item.C) || 0; });

    let bbTotal = 0, bbTickets = bbData.length;
    bbData.forEach(item => { bbTotal += parseInt(item.LC) || 0; });

    const snapshot = {
      date: today,
      timestamp: Date.now(),
      nap: { total: napTotal, critical: napCritical },
      lcp: { total: lcpTotal, clients: lcpClients },
      olt: { total: oltData.length, up: oltUp, down: oltDown, lowPower: oltLowPower, uplinkDown: oltUplinkDown, degradation: oltDegradation, clientsDown: oltClientsDown },
      node: { tickets: nodeTickets, equipment: nodeEquipment },
      backbone: { tickets: bbTickets, links: bbTotal }
    };

    // Save
    const db2 = await openDB();
    const tx2 = db2.transaction(STORE_NAME, 'readwrite');
    tx2.objectStore(STORE_NAME).put(snapshot);

    // Cleanup old snapshots (>90 days)
    cleanupOldSnapshots(db2);

    _snapshotWritten = true;
    console.log('[IndexedDB] Snapshot saved for', today);
    return true;
  } catch (err) {
    console.error('[IndexedDB] Failed to save snapshot:', err);
    return false;
  }
}

/**
 * Which stored days look incomplete.
 *
 * A snapshot is now only written once every module has been filled, so a record
 * with OLT at zero is almost certainly one written by the OLD blind-timer path
 * rather than a day when the plant genuinely had no OLTs — `nap` and `olt` are read
 * from the same spreadsheet in the same pass, so "NAP has rows while OLT has none"
 * is the tell. A day can legitimately read zero if the OLT sheet itself was empty,
 * which is why this reports rather than deletes.
 *
 * Worth looking at because a snapshot can never be repaired in place: the FIRST
 * record of a day is the record for that day, so an incomplete one stays wrong.
 */
function auditSnapshots(snapshots) {
  return (snapshots || []).map((s) => {
    const oltTotal = (s.olt && s.olt.total) || 0;
    const napTotal = (s.nap && s.nap.total) || 0;
    const lcpTotal = (s.lcp && s.lcp.total) || 0;

    return {
      date: s.date,
      oltTotal: oltTotal,
      up: (s.olt && s.olt.up) || 0,
      napTotal: napTotal,
      lcpTotal: lcpTotal,
      lcpClients: (s.lcp && s.lcp.clients) || 0,
      bbTickets: (s.backbone && s.backbone.tickets) || 0,
      suspect: oltTotal === 0 && (napTotal > 0 || lcpTotal > 0)
    };
  });
}

/**
 * Remove one day — or a list of days — from the trend history. Returns how many
 * records actually existed and went.
 *
 * Targeted on purpose: `clearIndexedDB()` in cache-control.js drops the whole
 * database, which is the wrong tool for one bad record — it costs all 90 days to
 * fix one.
 */
async function deleteSnapshots(dates) {
  const list = (Array.isArray(dates) ? dates : [dates]).filter(Boolean);
  if (!list.length) return 0;

  const db = await openDB();

  const deleted = await new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let count = 0;

    // Every request is issued from inside another request's handler, never across
    // an `await`: a transaction commits as soon as it goes idle, and a store call
    // on a committed transaction throws TransactionInactiveError.
    list.forEach((date) => {
      const get = store.get(date);
      get.onsuccess = () => {
        if (!get.result) return;              // nothing stored for that day
        const del = store.delete(date);       // the keyPath IS the date
        del.onsuccess = () => { count++; };
      };
    });

    tx.oncomplete = () => resolve(count);
    tx.onerror = () => resolve(count);
    tx.onabort = () => resolve(count);
  });

  // If today was one of them, this page session has to be allowed to write again.
  // Without this the rewrite is refused for the rest of the session and the
  // deletion looks like it did nothing until a reload.
  if (list.indexOf(new Date().toISOString().slice(0, 10)) !== -1) _snapshotWritten = false;

  return deleted;
}

/**
 * Drop TODAY's record and write it again from whatever is loaded right now.
 *
 * The only way a bad record can be repaired, since saveDailySnapshot() keeps the
 * first record of each day. If any module is missing from `dataCache`, the rewrite
 * is skipped by the completeness guard and the day is left EMPTY — a truthful gap
 * rather than a false zero.
 *
 * There is deliberately no way to do this for a PAST day. A snapshot is built from
 * the live module caches, and those hold NOW, so "repairing" an old date would
 * delete that day and then write today's numbers over it — losing the real day and
 * gaining nothing. For a past day the honest options are to leave it or to drop it
 * (deleteSnapshots), and the caller has to choose knowingly.
 */
async function rebuildSnapshot(date) {
  const today = new Date().toISOString().slice(0, 10);
  const target = date || today;

  if (target !== today) {
    return { date: target, deleted: 0, rewritten: false, reason: 'past-day' };
  }

  const deleted = await deleteSnapshots(target);
  const rewritten = await saveDailySnapshot();

  return {
    date: target,
    deleted: deleted,
    rewritten: rewritten,
    reason: rewritten ? 'rewritten' : 'not-loaded'
  };
}

// Get historical snapshots
async function getSnapshots(days = 30) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const all = await new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });

    // Filter last N days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    return all
      .filter(s => s.date >= cutoffStr)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    console.error('[IndexedDB] Failed to read snapshots:', err);
    return [];
  }
}

// Delete snapshots older than RETENTION_DAYS
function cleanupOldSnapshots(db) {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();

    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.key < cutoffStr) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
  } catch (err) {
    console.error('[IndexedDB] Cleanup failed:', err);
  }
}
