// ====================== IndexedDB MODULE ======================
// Offline-first data storage para sa daily snapshots & trend charts

const DB_NAME = 'netpulse-db';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const RETENTION_DAYS = 90;

// Open database
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'date' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// Save daily snapshot (one per day)
async function saveDailySnapshot() {
  try {
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

    if (existing) return; // Already saved today

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

    console.log('[IndexedDB] Snapshot saved for', today);
  } catch (err) {
    console.error('[IndexedDB] Failed to save snapshot:', err);
  }
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
