# 🏗️ GVSI NetPulse — System Enhancement & Optimization Roadmap

**Application:** NetPulse v3.3.0 (Progressive Web App)
**Audit Date:** August 26, 2026
**Auditor:** Buffy (Senior Full-Stack Architect)
**Scope:** Full-stack system audit — Backend (Apps Script/Sheets), Frontend (JS/UI/PWA), Data Engineering

---

## 📋 Executive Summary

### Current Health: 🟡 MODERATE — Functional but fragile at scale

NetPulse is a well-featured PWA for network monitoring with 25+ features across 7 modules. For 3 users, the system **works** but contains several architectural time bombs that will cause crashes or data corruption if the system scales or if edge cases are triggered.

### Critical Findings (Severity Ranked)

| # | Finding | Severity | Impact |
|---|---------|----------|--------|
| 1 | **CacheService 100KB limit** — OLT data (460 rows × 28 cols) may exceed the 100KB per-key limit, causing silent cache failure and full Sheets re-read on every request | 🔴 HIGH | Backend crash under load |
| 2 | **XSS via innerHTML** — Only 2 of ~15 render functions use DOMPurify; template literals inject raw data from Google Sheets | 🔴 HIGH | Security vulnerability |
| 3 | **Memory leak in Chart.js** — Analytics creates new Chart instances on every tab visit without destroying old ones | 🟡 MEDIUM | Browser memory growth |
| 4 | **Version guard destroys all localStorage** — Including auth session, theme, and cached data | 🟡 MEDIUM | User logout on every deploy |
| 5 | **Auto-login with `new Event('submit')`** — Fragile; `handleLogin` expects a form submit event with `preventDefault()` | 🟡 MEDIUM | Silent auth failure |
| 6 | **No cache stampede protection** — 3 simultaneous users can all miss cache and hit Sheets concurrently | 🟡 MEDIUM | Apps Script quota exhaustion |
| 7 | **Hardcoded column indexes** — 30+ magic numbers in code.gs; any sheet restructure breaks the backend | 🟠 LOW | Maintenance nightmare |
| 8 | **Export toolbar DOM pollution** — Re-created on every data render, never cleaned up | 🟠 LOW | Duplicate buttons |

---

## 1. 🔧 Backend (Apps Script / Google Sheets)

### 1.1 Execution Quota & Caching

#### Finding: CacheService 100KB Limit Risk
```
Google Apps Script CacheService limit: 100KB per key, 500KB total
OLT data payload: ~460 OLTs × 28 fields × ~20 bytes avg = ~250KB JSON
```

**Current behavior:** The cache silently fails if the payload exceeds 100KB (`cache.put` catches errors and logs them). This means OLT data may **never actually cache**, causing every request to hit Google Sheets directly.

**Recommendation:**
- Split OLT data into chunks OR reduce payload size by removing empty fields
- Add cache size monitoring: `if (jsonResponse.length > 90000) Logger.log('WARNING: Cache will fail')`
- Consider PropertiesService for larger payloads (has 500KB limit per property)

#### Finding: Monolithic doGet Function
The entire `doGet` is a single 180-line if-else chain. Each request reads ALL data for a type, even if the frontend only needs a subset.

**Recommendation:**
- Add `columns` parameter: `?type=olt&columns=P,M,N,S` to fetch only needed fields
- Consider splitting into separate Apps Script functions per module

#### Finding: No Cache Stampede Protection
When cache expires, all 3 users hitting the app simultaneously will all read from Sheets concurrently.

**Recommendation:**
- Implement lock-based fetch: `LockService.getScriptLock()` with try-catch
- Or use time-based cache refresh: Run `updateAgingDurationStatic()` on a time-driven trigger instead of on-demand

### 1.2 Apps Script Triggers (Currently Manual)

The aging duration scripts (`AgingDurationColX.gs`, `AgingDurationColP(BBxNODE).gs`) are designed to be run manually or via triggers but there's no time-driven trigger set up.

**Recommendation:**
- Set up time-driven triggers:
  - `updateAgingDurationStatic` → Every 15 minutes (OLT aging)
  - `updateAgingDurationColP` → Every 30 minutes (Node/Backbone aging)
  - `processBackboneTickets` → On edit (or every hour)
  - `processAllNodeDownRows` → On edit (or every hour)
  - `autoExportSheetToExcel` → Daily at 6:00 AM

### 1.3 Data Integrity

#### Finding: Inconsistent Null Handling
```javascript
// code.gs uses different defaults:
var agingRaw = String(rowB[23] || "").trim();    // → ""
var downtimeRaw = rowB[13] ? formatDateVal(rowB[13]) : "-";  // → "-"
var remarksRaw = rowB[20] ? String(rowB[20]).trim() : "-";   // → "-"
```

**Recommendation:** Standardize all null values to `"-"` in code.gs before sending to frontend.

#### Finding: Hardcoded Column Indexes
```javascript
var provinceRaw = String(rowB[3] || "").trim(); // Column D (Index 3)
var ticketRaw = String(rowB[5] || "").trim();   // Column F (Index 5)
// ... 30+ more magic numbers
```

**Recommendation:** Define column constants at the top of code.gs:
```javascript
const COL = {
  OLT_PROVINCE: 0,    // Column A
  OLT_MUNICIPALITY: 1, // Column B
  OLT_NAME: 2,         // Column C
  // ...
};
```

---

## 2. 🖥️ Frontend (JS/UI/Render)

### 2.1 Crash Risks & Error Handling

#### Finding: Version Guard Destroys All State
```javascript
// index.html line ~620
localStorage.clear();  // Destroys: session, theme, remember_me, fcm_token, app_version
sessionStorage.clear();
```

**Impact:** Every version bump logs out all users, resets dark mode, clears notification subscriptions.

**Recommendation:** Only clear version-specific keys:
```javascript
const keysToPreserve = ['theme', 'notif_enabled', 'fcm_token', 'netpulse_remember'];
const preserved = {};
keysToPreserve.forEach(k => { preserved[k] = localStorage.getItem(k); });
localStorage.clear();
Object.entries(preserved).forEach(([k, v]) => { if (v) localStorage.setItem(k, v); });
```

#### Finding: Auto-Login Fragility
```javascript
// index.html line ~965
handleLogin(new Event('submit'));
```

`handleLogin` calls `e.preventDefault()` which works on `new Event('submit')` but is semantically wrong. If the event model changes, this breaks silently.

**Recommendation:** Extract login logic into a separate `performLogin(username, password)` function that both the form handler and auto-login call directly.

#### Finding: Unguarded DOM Access
```javascript
// olt-module.js line ~46
document.getElementById('oltCardTotal').textContent = totalOlt;
// If element doesn't exist (e.g., during skeleton loading), this throws
```

**Recommendation:** Add null checks:
```javascript
const el = document.getElementById('oltCardTotal');
if (el) el.textContent = totalOlt;
```

### 2.2 XSS Vulnerabilities

#### Finding: Inconsistent DOMPurify Usage
```javascript
// sanitizeHTML is defined but only used in 2 places:
// ✅ node-module.js: ${sanitizeHTML(node)}
// ✅ backbone-module.js: ${sanitizeHTML(link)}
// ❌ nap-module.js: ${area} — raw data
// ❌ lcp-module.js: ${area} — raw data
// ❌ olt-module.js: ${name} — raw data
// ❌ analytics-module.js: ${prov} — raw data
```

**Recommendation:** Apply `sanitizeHTML()` to ALL dynamic data in template literals, especially:
- Province names (could contain HTML if manually edited in Sheets)
- Ticket numbers
- Remarks fields
- OLT names

#### Finding: onclick String Injection Risk
```javascript
// backbone-module.js
const safeProvince = province.replace(/'/g, "\\'").replace(/"/g, '&quot;');
tr.onclick = () => openBackboneModal('${safeProvince}', ...);
```

This escaping is fragile. A province name with backticks, `${}`, or other special chars could break the string.

**Recommendation:** Use `data-*` attributes instead of inline onclick with string parameters:
```javascript
tr.dataset.province = province;
tr.dataset.ticket = ticketNo;
tr.onclick = function() {
  openBackboneModal(this.dataset.province, this.dataset.ticket, ...);
};
```

### 2.3 Memory Leaks

#### Finding: Chart.js Instance Leak
```javascript
// analytics-module.js
new Chart(ctx1, { ... });  // Creates instance but never stores reference
// On next analytics tab visit, new Chart is created on same canvas → memory leak
```

**Recommendation:**
```javascript
// Store chart instances globally
window._analyticsCharts = window._analyticsCharts || [];
// Before creating new charts:
window._analyticsCharts.forEach(c => c.destroy());
window._analyticsCharts = [];
// After creating:
window._analyticsCharts.push(chart);
```

#### Finding: Export Toolbar Duplication
Every `render*()` function checks `if (!tab.querySelector('.export-toolbar'))` but the check can fail if the tab content is replaced via `innerHTML`.

**Recommendation:** Create export toolbars once in HTML and toggle visibility, or use a single render pass.

### 2.4 Performance

#### Finding: No Debounce on Search
```javascript
// index.html
function filterTable(tbodyId, query) {
  // Iterates ALL rows on every keystroke
}
```

**Recommendation:** Add 200ms debounce to search input:
```html
oninput="debounce('search-'+tbodyId, () => filterTable(tbodyId, this.value), 200)"
```

#### Finding: innerHTML Forced Reflow
```javascript
// Every render function does:
tbody.innerHTML = '';
dataRows.forEach(row => tbody.appendChild(row));
```

**Recommendation:** Build HTML string first, then set innerHTML once:
```javascript
let html = '';
dataRows.forEach(row => { html += row.outerHTML; });
tbody.innerHTML = html;
```

#### Finding: Redundant Prefetching
`prefetchOtherTabsInBackground` fetches ALL modules even if user only visits NAP tab.

**Recommendation:** Prefetch only the next likely tab (e.g., if on NAP, prefetch LCP only).

---

## 3. 📊 Data Engineering (RegEx/Parsers)

### 3.1 Regex Reliability

#### Finding: OLT Name Pattern Too Strict
```javascript
// ExtractOLT.gs
/[A-Z0-9]+-OLT-[0-9]+/gi
```
This won't match OLT names like `SMY001-OLT-01-A` or `LAY001-OLT-01/B`.

**Recommendation:** Make pattern more flexible:
```javascript
/[A-Z0-9]+-OLT-[0-9]+[A-Z\-\/]*/gi
```

#### Finding: Backbone Link Extraction Over-Fragmented
`processBackboneTickets` has 3 regex patterns that could overlap. A single line might match multiple patterns.

**Recommendation:** Consolidate into a single comprehensive pattern with named capture groups.

### 3.2 String Operations

#### Finding: Province Underscore Replacement in Frontend
```javascript
// Called on EVERY row in EVERY module:
const province = provinceRaw.toString().replace(/_/g, ' ');
```

**Recommend:** Do this once in code.gs before sending to frontend:
```javascript
"P": provinceRaw.replace(/_/g, " ")
```
(Saves ~460 string operations per OLT request)

---

## 4. 🛡️ Risk & Mitigation Strategy

### Crash Scenarios

| Scenario | Probability | Impact | Mitigation |
|----------|-------------|--------|------------|
| CacheService 100KB overflow | HIGH (with 460+ OLTs) | Full Sheets re-read per request | Split payload or reduce fields |
| Chart.js memory leak | MEDIUM (after 10+ analytics visits) | Browser tab becomes unresponsive | Destroy chart instances before re-creating |
| Version guard + localStorage.clear() | HIGH (every deploy) | All users logged out, theme reset | Preserve essential keys |
| XSS via Province name | LOW (internal data) | Potential script execution | Apply DOMPurify universally |
| Cache stampede (3 users) | LOW (3 users only) | Apps Script quota spike | Add LockService |
| Auto-login failure | MEDIUM | User sees blank screen | Extract performLogin() helper |
| Apps Script 6-minute timeout | LOW (current data size) | Partial data returned | Add timeout handling in doGet |

### Data Loss Scenarios

| Scenario | Probability | Impact | Mitigation |
|----------|-------------|--------|------------|
| Google Sheet column reorder | MEDIUM | All data mapping breaks | Use named ranges or column constants |
| Sheet tab rename | LOW | Module returns empty data | Add sheet existence check + error message |
| User edits formula cells | MEDIUM | Extract functions produce wrong data | Lock formula cells via sheet protection |

---

## 5. 📌 Action Plan (Prioritized)

### 🔴 Priority 1 — Critical Fixes (Do First)

| # | Task | Files | Effort |
|---|------|-------|--------|
| 1.1 | **Fix CacheService overflow** — Split OLT payload or add size check | `code.gs` | 30 min |
| 1.2 | **Apply DOMPurify to ALL render functions** — Wrap all template literal data in `sanitizeHTML()` | `nap-module.js`, `lcp-module.js`, `olt-module.js`, `analytics-module.js` | 45 min |
| 1.3 | **Fix Chart.js memory leak** — Store and destroy chart instances | `analytics-module.js` | 20 min |
| 1.4 | **Fix version guard** — Preserve essential localStorage keys | `index.html` | 15 min |
| 1.5 | **Extract performLogin()** — Separate auth logic from form event | `index.html` | 20 min |

### 🟡 Priority 2 — Stability Improvements

| # | Task | Files | Effort |
|---|------|-------|--------|
| 2.1 | **Add column constants to code.gs** — Replace magic numbers | `code.gs` | 45 min |
| 2.2 | **Add null checks to all DOM access** — Prevent null.textContent crashes | All modules | 30 min |
| 2.3 | **Debounce search inputs** — 200ms delay on keystroke | `index.html` | 10 min |
| 2.4 | **Fix onclick injection** — Use data-* attributes | `backbone-module.js`, `node-module.js` | 30 min |
| 2.5 | **Standardize null handling** — All `"-"` or all `""` | `code.gs` | 20 min |

### 🟢 Priority 3 — Performance & UX

| # | Task | Files | Effort |
|---|------|-------|--------|
| 3.1 | **Set up time-driven triggers** — Auto-run aging scripts | Apps Script | 15 min |
| 3.2 | **Optimize prefetching** — Only prefetch next likely tab | `index.html` | 20 min |
| 3.3 | **Batch DOM updates** — Build HTML string, set innerHTML once | All modules | 45 min |
| 3.4 | **Move province underscore replacement to backend** | `code.gs` | 10 min |
| 3.5 | **Add cache size monitoring** — Log warnings when approaching limit | `code.gs` | 10 min |

### 🔮 Priority 4 — Future Enhancements

| # | Task | Description |
|---|------|-------------|
| 4.1 | **IndexedDB for frontend caching** | Replace localStorage dataCache with IndexedDB for larger payloads |
| 4.2 | **Web Workers for analytics** | Offload Chart.js rendering and data processing |
| 4.3 | **API response compression** | Use gzip in Apps Script response |
| 4.4 | **Error boundary component** | Global error catcher that shows friendly error page |
| 4.5 | **Unit tests** | Add Jest tests for module render functions |

---

## 📁 File-by-File Summary

| File | Lines | Issues Found | Priority |
|------|-------|-------------|----------|
| `index.html` | 1508 | Version guard, auto-login fragility, XSS inconsistency, no search debounce | 🔴 P1 |
| `code.gs` | 220 | CacheService limit, hardcoded indexes, inconsistent nulls, no triggers | 🔴 P1 |
| `olt-module.js` | 180 | Chart.js leak, null DOM access, XSS | 🔴 P1 |
| `analytics-module.js` | 450 | Chart.js leak (4 instances), XSS, comparison mode uses fake data | 🔴 P1 |
| `nap-module.js` | 90 | XSS in template literals | 🟡 P2 |
| `lcp-module.js` | 110 | XSS in template literals | 🟡 P2 |
| `node-module.js` | 120 | onclick injection risk, XSS | 🟡 P2 |
| `backbone-module.js` | 230 | onclick injection (9 params!), XSS | 🟡 P2 |
| `db.js` | 100 | Clean — no major issues | ✅ |
| `notifications.js` | 180 | Firebase config hardcoded, no error recovery | 🟢 P3 |
| `sw.js` | 75 | Clean — proper cache strategy | ✅ |
| `styles.css` | 1870 | Clean — no major issues | ✅ |
| `ExtractOLT.gs` | 55 | Regex could be more flexible | 🟢 P3 |
| `ExtractNodeDown.gs` | 95 | Clean — well structured | ✅ |
| `ExtractLinksinBB.gs` | 95 | Multiple overlapping regex patterns | 🟢 P3 |
| `AgingDurationColX.gs` | 50 | Should be time-triggered, not manual | 🟢 P3 |
| `AgingDurationColP(BBxNODE).gs` | 55 | Should be time-triggered, not manual | 🟢 P3 |
| `autoBackupsheet.gs` | 30 | Clean — well structured | ✅ |

---

## ✅ What's Working Well

| Area | Details |
|------|---------|
| **PWA Architecture** | Service worker cache-first strategy is solid; offline shell loads instantly |
| **Modular Design** | Separate .js files per module — clean separation of concerns |
| **DOMPurify Integration** | XSS protection is in place (just needs consistent application) |
| **Cache TTL Strategy** | 60s for tickets, 180s for summaries — appropriate for use case |
| **Skeleton Loading** | Professional loading UX with shimmer placeholders |
| **Pull-to-Refresh** | 120px threshold with hold-to-confirm — prevents accidental refresh |
| **Error Toast System** | User-friendly error/success messages |
| **IndexedDB Snapshots** | Daily data retention for trend analysis — forward-thinking |
| **Dark Mode** | Complete theme system with CSS variables — well implemented |
| **Accessibility** | Keyboard shortcuts (R, 1-7, Esc, ?) — nice touch |

---

**End of Audit Report**

*Generated by Buffy (Senior Full-Stack Architect) — August 26, 2026*
