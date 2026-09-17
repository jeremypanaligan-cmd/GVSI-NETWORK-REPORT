# MIGRATION TO SUPABASE TODO

## Overview
Migrate from Google Sheets + Apps Script to Supabase (PostgreSQL) for faster, more reliable data access.

**Current Architecture:**
```
Main Sheet -> IMPORTRANGE() + QUERY() -> Display Sheet -> Apps Script -> App (10-30s, intermittent 404s)
```

**Target Architecture:**
```
Main Sheet -> IMPORTRANGE() + QUERY() -> Display Sheet -> onChange Trigger -> Supabase -> App (100-500ms)
```

---

## Phase 1: Supabase Setup ✅

- [x] Create Supabase account at supabase.com
- [x] Create new project (name: GVSI NetPulse)
- [x] Note project URL and API keys
- [x] Open SQL Editor
- [x] Run schema creation SQL (see Appendix A)
- [x] Verify tables created
- [x] Enable Row Level Security (RLS)
- [x] Create public read-only policy

**Project Details:**
- Project URL: https://fsebdacptgoknbjqdlor.supabase.co
- Publishable Key: sb_publishable_9qnGRj2VAE1Bxm0lcqRTrQ_29pZZqoq
- Secret Key: sb_secret_aovETmmfnWYKlM3wGSvpwA_XCoVAj4O

---

## Phase 2: Data Migration ✅

- [x] Export display sheet data to CSV
  - [x] OLT DOWN Tickets
  - [ ] Node DOWN Tickets (NO PENDING TICKET - empty)
  - [ ] Backbone Tickets (needs verification)
  - [ ] LCP Tickets (needs verification)
- [x] Import CSV to Supabase (via Apps Script)
- [x] Verify row counts match (OLT only)
- [ ] Verify Backbone data
- [ ] Verify LCP data

---

## Phase 3: Apps Script Sync ✅

- [x] Open display sheet in Google Sheets
- [x] Open Apps Script editor (Extensions -> Apps Script)
- [x] Create new project file: supabase-sync.gs
- [x] Add config constants:
  - [x] SUPABASE_URL: https://fsebdacptgoknbjqdlor.supabase.co
  - [x] SUPABASE_KEY: sb_secret_aovETmmfnWYKlM3wGSvpwA_XCoVAj4O
- [x] Add sync functions:
  - [x] onChange(e) - simple trigger
  - [x] syncAllModules() - orchestrator
  - [x] syncOltDownTickets() - OLT sync (WORKING)
  - [ ] syncNodeDownTickets() - Node sync (needs sheet name check)
  - [ ] syncBackboneTickets() - Backbone sync (needs sheet name check)
  - [ ] syncLcpTickets() - LCP sync (needs sheet name check)
  - [x] syncToSupabase(table, data) - generic upsert (FIXED)
- [x] Add setup functions:
  - [x] setupTrigger() - time-driven trigger (every 5 mins)
  - [x] initialSync() - populate Supabase
- [x] Deploy Apps Script (Deploy -> New Deployment)
- [x] Run setupTrigger() once
- [x] Run initialSync() once
- [x] Verify data in Supabase dashboard (OLT only)

**Issues Found:**
1. DNS error: Wrong project ID (missing 'o') - FIXED
2. Column mapping off by one - FIXED
3. Duplicate key error (409) - FIXED (upsert with on_conflict)
4. Only OLT has data - Node/Backbone/LCP need sheet name verification

---

## Phase 4: Client Update ⏳

- [ ] Add Supabase config to index.html:
  - [ ] SUPABASE_URL
  - [ ] SUPABASE_ANON_KEY
- [ ] Update fetch functions:
  - [ ] fetchOltDownTickets() -> Supabase
  - [ ] fetchNodeDownTickets() -> Supabase
  - [ ] fetchBackboneTickets() -> Supabase
  - [ ] fetchLcpTickets() -> Supabase
- [ ] Keep Apps Script for:
  - [ ] NAP data (low frequency, small payload)
  - [ ] LCP aging report
  - [ ] OLT report (461 rows)
  - [ ] Authentication/login
- [ ] Test each module
- [ ] Verify performance improvement

---

## Phase 5: Testing ⏳

- [ ] Test onChange trigger:
  - [ ] Add new OLT ticket to main sheet, verify sync
  - [ ] Edit existing ticket, verify update
  - [ ] Delete ticket, verify removal
- [ ] Test app:
  - [ ] Load each module
  - [ ] Verify data matches Google Sheets
  - [ ] Check console for errors
- [ ] Test edge cases:
  - [ ] Offline to online transition
  - [ ] Multiple rapid edits
  - [ ] Large data sets

---

## Phase 6: Deployment ⏳

- [ ] Commit all changes
- [ ] Push to GitHub
- [ ] Verify GitHub Pages deployment
- [ ] Test in production
- [ ] Monitor Supabase dashboard for errors
- [ ] Document rollback procedure

---

## Appendix A: Schema SQL

```sql
-- OLT DOWN Tickets
CREATE TABLE olt_down_tickets (
  id SERIAL PRIMARY KEY,
  ticket_no TEXT UNIQUE NOT NULL,
  month_year TEXT,
  date DATE,
  province TEXT,
  area TEXT,
  downtime_cause TEXT,
  description TEXT,
  impact TEXT,
  issue TEXT,
  from_team TEXT,
  down_time TIMESTAMP,
  date_endorsed TIMESTAMP,
  remarks TEXT,
  aging_duration TEXT,
  number_of_olts INT DEFAULT 0,
  number_of_clients INT DEFAULT 0,
  equipments_affected TEXT,
  synced_at TIMESTAMP DEFAULT NOW()
);

-- Node DOWN Tickets
CREATE TABLE node_down_tickets (
  id SERIAL PRIMARY KEY,
  ticket_no TEXT UNIQUE NOT NULL,
  month_year TEXT,
  date DATE,
  province TEXT,
  area TEXT,
  description TEXT,
  impact TEXT,
  issue TEXT,
  from_team TEXT,
  down_time TIMESTAMP,
  date_endorsed TIMESTAMP,
  remarks TEXT,
  aging_duration TEXT,
  count_of_eqp INT DEFAULT 0,
  equipments_affected TEXT,
  synced_at TIMESTAMP DEFAULT NOW()
);

-- Backbone Tickets
CREATE TABLE backbone_tickets (
  id SERIAL PRIMARY KEY,
  ticket_no TEXT UNIQUE NOT NULL,
  month_year TEXT,
  date DATE,
  province TEXT,
  area TEXT,
  service TEXT,
  description TEXT,
  impact TEXT,
  category TEXT,
  from_team TEXT,
  down_time TIMESTAMP,
  date_endorsed TIMESTAMP,
  remarks TEXT,
  aging_duration TEXT,
  links_affected TEXT,
  count_of_links INT DEFAULT 0,
  synced_at TIMESTAMP DEFAULT NOW()
);

-- LCP Tickets
CREATE TABLE lcp_tickets (
  id SERIAL PRIMARY KEY,
  ticket_no TEXT UNIQUE NOT NULL,
  month_year TEXT,
  date DATE,
  province TEXT,
  area TEXT,
  description TEXT,
  impact TEXT,
  issue TEXT,
  from_team TEXT,
  down_time TIMESTAMP,
  date_endorsed TIMESTAMP,
  remarks TEXT,
  aging_duration TEXT,
  clients INT DEFAULT 0,
  synced_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_olt_tickets_no ON olt_down_tickets(ticket_no);
CREATE INDEX idx_node_tickets_no ON node_down_tickets(ticket_no);
CREATE INDEX idx_backbone_tickets_no ON backbone_tickets(ticket_no);
CREATE INDEX idx_lcp_tickets_no ON lcp_tickets(ticket_no);
```

---

## Appendix B: Apps Script Code

Key functions implemented:
- onChange(e) - simple trigger
- syncAllModules() - orchestrator
- syncOltDownTickets() - OLT sync (WORKING)
- syncNodeDownTickets() - Node sync
- syncBackboneTickets() - Backbone sync
- syncLcpTickets() - LCP sync
- syncToSupabase(table, tickets) - generic upsert (FIXED)
- setupTrigger() - time-driven trigger (every 5 mins)
- initialSync() - populate Supabase

---

## Appendix C: Client Code

Key changes:
- Add SUPABASE_URL, SUPABASE_ANON_KEY
- Update fetch functions to use Supabase
- Keep Apps Script for NAP, LCP aging, OLT report, auth

---

## Timeline

| Phase | Duration | Status |
|-------|----------|--------|
| Phase 1: Supabase Setup | 15 mins | Done |
| Phase 2: Data Migration | 30 mins | Done (partial) |
| Phase 3: Apps Script Sync | 1 hour | Done (partial) |
| Phase 4: Client Update | 1 hour | Pending |
| Phase 5: Testing | 30 mins | Pending |
| Phase 6: Deployment | 30 mins | Pending |
| **Total** | **4 hours** | |

---

## Notes

- **Trigger:** Time-driven (every 5 mins) - onChange does not fire on IMPORTRANGE
- **Sync interval:** Near real-time (5 min max delay)
- **Fallback:** Manual sync button if needed
- **Rollback:** Keep Apps Script doGet() functions, revert BASE_API_URL

---

## Known Issues

1. **Only OLT has data** - Need to verify sheet names for Node/Backbone/LCP
2. **Node sheet empty** - "NO PENDING TICKET" (normal)
3. **Column mapping** - Fixed for OLT, need to verify for others
