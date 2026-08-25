# GVSI NetPulse — Analytics Dashboard Documentation

**Version:** 3.2.1  
**Last Updated:** August 25, 2026  
**Prepared by:** Network Operations Center (NOC)

---

## Table of Contents

1. [Overview](#overview)
2. [Stat Cards](#stat-cards)
3. [Module Snapshot](#module-snapshot)
4. [Donut Charts](#donut-charts)
5. [Aging Timeline](#aging-timeline)
6. [Top Provinces](#top-provinces)
7. [Critical Tickets Table](#critical-tickets-table)
8. [Trend Charts](#trend-charts)
9. [How to Use](#how-to-use)

---

## 1. Overview

The Analytics Dashboard provides a consolidated view of all network incidents across all modules (NAP, LCP, OLT, Node, Backbone). It aggregates data from individual modules to present a high-level summary for decision-making and resource allocation.

**Data Sources:**
- NLZ NAP Report (NAP Outages)
- NLZ LCP Report (LCP Outages)
- NLZ OLT Report (OLT Status)
- OLT DOWN Tickets
- Node DOWN Tickets
- Backbone Tickets
- IndexedDB (local snapshots for trend analysis)

---

## 2. Stat Cards

Located at the top of the Analytics Dashboard, these four summary cards provide instant visibility into the overall network health.

### 2.1 Total Active Incidents

| Field | Description |
|-------|-------------|
| **Metric** | Sum of all active incidents across all modules |
| **Formula** | NAP Total + LCP Total + OLT (Down + Low Power + Uplink Down + Degradation) + Node Tickets + Backbone Tickets |
| **Purpose** | Provides a single number representing the current total workload for the NOC team |
| **Target** | Should trend downward as incidents are resolved |

**Example:**
```
NAP: 15 incidents
LCP: 8 incidents
OLT: 3 incidents (DOWN)
Node: 2 incidents
Backbone: 5 incidents
─────────────────────
TOTAL: 33 Active Incidents
```

---

### 2.2 Clients Affected

| Field | Description |
|-------|-------------|
| **Metric** | Total number of subscribers/customers impacted by active incidents |
| **Formula** | OLT Affected Clients + LCP Affected Clients |
| **Purpose** | Measures the business impact of network incidents — directly correlates to customer experience |
| **Target** | Should be as close to zero as possible |

**Example:**
```
OLT DOWN clients: 1,206
LCP clients: 350
─────────────────────
TOTAL: 1,556 Clients Affected
```

---

### 2.3 Total Tickets

| Field | Description |
|-------|-------------|
| **Metric** | Count of all open/in-progress tickets across modules |
| **Formula** | OLT Tickets + Node Tickets + Backbone Tickets + LCP Tickets |
| **Purpose** | Shows the volume of support tickets requiring attention |
| **Target** | Higher than Active Incidents (some tickets may be for the same incident) |

---

### 2.4 Critical (>3 Days)

| Field | Description |
|-------|-------------|
| **Metric** | Number of NAP and LCP incidents that have been active for more than 3 days |
| **Formula** | NAP >3 Days + LCP >3 Days |
| **Purpose** | Highlights aging incidents that are at risk of SLA breach or require escalation |
| **Target** | Should be zero — anything above zero needs immediate attention |

**Color Coding:**
- 🟢 **0-2**: Normal — within acceptable aging
- 🟡 **3-5**: Warning — aging incidents approaching critical threshold
- 🔴 **6+**: Critical — requires immediate escalation

---

## 3. Module Snapshot

Five summary cards showing the status of each individual module at a glance.

### 3.1 NAP (Network Access Point)

| Field | Description |
|-------|-------------|
| **Main Value** | Total NAP outages currently active |
| **Sub-info** | Breakdown by aging: <24 hours, 1-3 days, >3 days |
| **Icon** | Green monitor icon |
| **Color** | Green theme |

**Interpretation:**
- High numbers in >3 days = aging NAP issues need investigation
- All in <24h = recent issues, actively being worked on

---

### 3.2 LCP (Local Convergence Point)

| Field | Description |
|-------|-------------|
| **Main Value** | Total LCP outages currently active |
| **Sub-info** | Clients affected + number of LCPs down |
| **Icon** | Yellow layers icon |
| **Color** | Yellow theme |

**Interpretation:**
- High client count = significant subscriber impact
- Multiple LCPs down in one area = possible upstream issue

---

### 3.3 OLT (Optical Line Terminal)

| Field | Description |
|-------|-------------|
| **Main Value** | Count of non-UP OLTs (DOWN + LOW POWER + UPLINK DOWN + DEGRADATION) |
| **Sub-info** | Affected clients + total OLTs in network |
| **Icon** | Red server icon |
| **Color** | Red theme |

**Interpretation:**
- Compare non-UP count vs total OLTs to get failure rate
- High affected clients = prioritize these OLTs for restoration

**Example:**
```
Non-UP OLTs: 3
Clients Affected: 1,206
Total OLTs: 460
─────────────────────
Failure Rate: 0.65%
```

---

### 3.4 NODE

| Field | Description |
|-------|-------------|
| **Main Value** | Total Node DOWN tickets |
| **Sub-info** | Number of equipment affected |
| **Icon** | Purple shield icon |
| **Color** | Purple theme |

**Interpretation:**
- Equipment count shows the blast radius of node failures
- High equipment count = node serves many downstream devices

---

### 3.5 BACKBONE

| Field | Description |
|-------|-------------|
| **Main Value** | Total Backbone tickets |
| **Sub-info** | Links affected + DWDM count + MPLS count |
| **Icon** | Orange link icon |
| **Color** | Orange theme |

**Interpretation:**
- DWDM tickets = core transport layer issues
- MPLS tickets = service routing issues
- Multiple links affected = possible fiber cut or equipment failure

---

## 4. Donut Charts

Two donut (pie) charts showing distribution of incidents by category.

### 4.1 OLT Status Distribution

| Segment | Color | Meaning |
|---------|-------|---------|
| 🟢 UP | Green | OLTs operating normally |
| 🔴 DOWN | Red | OLTs completely down — no service |
| 🟠 LOW POWER | Orange | OLT uplink has low optical power — degraded signal |
| 🟡 UPLINK DOWN | Yellow | OLT uplink is down — OLT isolated from network |
| 🟣 DEGRADATION | Purple | OLT experiencing service degradation |

**Center Display:**
- Shows the total number of OLTs in the network
- Percentage is calculated per segment

**How to Read:**
- A large green segment = healthy network
- Any red/orange/yellow segment = requires investigation
- The legend on the right shows exact counts and percentages

---

### 4.2 Backbone Service Type

| Segment | Color | Meaning |
|---------|-------|---------|
| 🟣 DWDM | Purple | Dense Wavelength Division Multiplexing — core transport fiber |
| 🟠 MPLS | Orange | Multiprotocol Label Switching — service routing |

**Sub-breakdown (below the chart):**

| Category | Color | Meaning |
|----------|-------|---------|
| DWDM Low Power | Yellow | DWDM link signal is weak — may fail soon |
| DWDM Link Down | Red | DWDM link is completely down — service interrupted |
| MPLS Low Power | Orange | MPLS link signal is weak — degraded performance |
| MPLS Link Down | Red | MPLS link is completely down — service interrupted |

**How to Read:**
- DWDM issues are more critical (core transport layer)
- MPLS issues affect service routing
- "Link Down" is more severe than "Low Power"

---

## 5. Aging Timeline (NAP + LCP)

A horizontal bar chart combining NAP and LCP incidents by aging category.

### 5.1 Components

| Bar | Color | Meaning | Target |
|-----|-------|---------|--------|
| <24 Hours | 🟢 Green | Incidents created within the last 24 hours | Should be majority |
| 1-3 Days | 🟡 Yellow | Incidents between 1 and 3 days old | Should be decreasing |
| >3 Days | 🔴 Red | Incidents older than 3 days | Should be zero |

### 5.2 How to Read

```
🟢 <24 Hours:   ████████████████░░░░  60% (30 tickets)
🟡 1-3 Days:    ██████░░░░░░░░░░░░░░  25% (12 tickets)
🔴 >3 Days:     ████░░░░░░░░░░░░░░░░  15% (8 tickets)
```

- **Ideal state:** Green bar should be the longest, red bar should be the shortest
- **Concerning state:** If red bar is growing, incidents are not being resolved quickly
- **Action needed:** When red bar exceeds 20%, escalate to management

### 5.3 SLA Reference

| Aging Category | SLA Status | Action Required |
|----------------|------------|-----------------|
| <24 Hours | ✅ Normal | Continue monitoring |
| 1-3 Days | ⚠️ Warning | Assign additional resources |
| >3 Days | 🔴 Critical | Escalate to management, daily updates |

---

## 6. Top Provinces by Incidents

A horizontal bar chart showing the top 10 provinces with the most active incidents.

### 6.1 Components

| Element | Description |
|---------|-------------|
| **Province Name** | Left-aligned label (underscores replaced with spaces) |
| **Bar Length** | Proportional to incident count — longest bar = most incidents |
| **Count** | Exact number of incidents on the right |

### 6.2 How to Read

```
BENGUET      ████████████████████  15
LA UNION     ██████████████░░░░░░  12
PANGASINAN   ██████████░░░░░░░░░░   8
ILOCOS SUR   ████████░░░░░░░░░░░░   6
CITY OF BAGUIO ████░░░░░░░░░░░░░░░   4
```

### 6.3 Data Aggregation

The chart combines incidents from ALL modules per province:
- NAP outages (weighted by total count)
- LCP outages (weighted by total count)
- OLT non-UP incidents (1 per OLT)
- Node tickets (1 per ticket)
- Backbone tickets (1 per ticket)

### 6.4 Actionable Insights

| Scenario | Interpretation | Action |
|----------|----------------|--------|
| One province dominates | Possible regional issue (power outage, fiber cut) | Investigate common cause |
| Multiple provinces high | Possible widespread issue | Check upstream/core network |
| Balanced distribution | Normal operation | Continue monitoring |

---

## 7. Critical OLT Tickets (Table)

A table listing OLT tickets with the longest aging duration.

### 7.1 Columns

| Column | Description |
|--------|-------------|
| **Province** | Location of the affected OLT |
| **OLT Name** | Identifier of the OLT (e.g., KYB001-OLT-01) |
| **Status** | Current status: DOWN, LOW POWER, UPLINK DOWN, or DEGRADATION |
| **Aging** | Duration since the incident started (Xd Yh Zm format) |
| **Clients** | Number of subscribers affected by this specific OLT |

### 7.2 How to Read

| Aging Format | Meaning |
|--------------|---------|
| `0d 4h 43m` | 4 hours and 43 minutes — recent incident |
| `6d 21h 38m` | Almost 7 days — requires escalation |
| `18d 18h 50m` | Almost 19 days — critical, management attention needed |

### 7.3 Action Matrix

| Aging | Status | Priority |
|-------|--------|----------|
| <24h | DOWN | 🟡 Monitor |
| 1-3 days | DOWN | 🟠 Escalate to team lead |
| >3 days | DOWN | 🔴 Escalate to management |
| Any | LOW POWER | 🟡 Monitor, schedule maintenance |
| Any | UPLINK DOWN | 🔴 Immediate attention |

---

## 8. Trend Charts (IndexedDB)

Four line/bar charts showing historical trends over the last 30 days. Data is sourced from daily IndexedDB snapshots.

> **Important:** Trend data builds over time. The charts require at least 2 days of snapshot data to display meaningful trends. Check back after a few days of use.

### 8.1 Incidents per Day (Stacked Bar)

| Field | Description |
|-------|-------------|
| **Chart Type** | Stacked bar chart |
| **X-axis** | Date (last 30 days) |
| **Y-axis** | Number of active incidents |
| **Segments** | NAP (teal), LCP (yellow), OLT (red), Node (purple), Backbone (orange) |

**What it shows:**
- Total active incidents on each day, broken down by module
- Stacked to show both the total and the contribution of each module

**How to Interpret:**
- Rising bars = network health is declining
- Falling bars = incidents are being resolved
- Spikes = possible major incident on that day
- Consistent height = steady state of incidents

**Note:** This chart shows the **total active incidents** on each day (snapshot), not newly created tickets. If the count drops from 15 to 12, it means 3 incidents were resolved.

---

### 8.2 OLT Status Trend (Line)

| Field | Description |
|-------|-------------|
| **Chart Type** | Line chart with area fill |
| **X-axis** | Date (last 30 days) |
| **Y-axis** | Number of OLTs |
| **Lines** | DOWN (red), LOW POWER (orange), UPLINK DOWN (yellow) |

**What it shows:**
- How the count of non-UP OLTs has changed over time
- Each status type is tracked separately

**How to Interpret:**
- Red line going up = more OLTs going DOWN — network degrading
- Red line going down = OLTs being restored — network improving
- Orange/yellow spikes = temporary power or uplink issues
- Flat lines = stable network status

---

### 8.3 Clients Affected Trend (Area)

| Field | Description |
|-------|-------------|
| **Chart Type** | Area chart with line |
| **X-axis** | Date (last 30 days) |
| **Y-axis** | Number of clients |
| **Lines** | OLT Clients (red), LCP Clients (yellow) |

**What it shows:**
- How the number of affected subscribers has changed over time
- Separated by OLT and LCP impact

**How to Interpret:**
- Area growing = more customers affected — critical issue
- Area shrinking = customers being restored — good progress
- Red area dominates = OLT issues are the primary customer impact
- Yellow area dominates = LCP issues are the primary customer impact

---

### 8.4 Aging Distribution (Stacked Bar)

| Field | Description |
|-------|-------------|
| **Chart Type** | Stacked bar chart |
| **X-axis** | Date (last 30 days) |
| **Y-axis** | Number of incidents |
| **Segments** | <24h (green), 1-3d (yellow), >3d (red) |

**What it shows:**
- How the aging profile of incidents has changed over time
- Combines NAP and LCP aging data

**How to Interpret:**
- Green dominant = incidents are being resolved quickly
- Red growing = incidents are aging — not being resolved fast enough
- Ideal: Green bars should increase while red bars decrease
- Concerning: If red bars are consistently growing, SLA breaches are imminent

---

## 9. How to Use

### 9.1 Daily NOC Checklist

| Step | Action | Where |
|------|--------|-------|
| 1 | Check Total Active Incidents | Stat Cards |
| 2 | Check Clients Affected | Stat Cards |
| 3 | Check Critical (>3 Days) | Stat Cards |
| 4 | Review Top Provinces | Bar Chart |
| 5 | Review Critical OLT Tickets | Table |

### 9.2 Weekly Review

| Step | Action | Where |
|------|--------|-------|
| 1 | Compare this week vs last week | Click "Compare Weeks" button |
| 2 | Review trend direction | Trend Charts |
| 3 | Check aging distribution | Aging Timeline |
| 4 | Identify provinces with most incidents | Top Provinces Chart |

### 9.3 Date Range Filters

| Filter | Use Case |
|--------|----------|
| **7 Days** | Short-term view — recent incidents and quick trends |
| **30 Days** | Standard view — monthly trend analysis (default) |
| **90 Days** | Long-term view — quarterly analysis, seasonal patterns |

### 9.4 Comparison Mode

Click the **"Compare Weeks"** button to enable week-over-week comparison. This shows:
- Current week values vs previous week
- Trend direction (up/down arrows)
- Difference in absolute numbers

> **Note:** Comparison data is currently simulated. It will use actual IndexedDB history when enough data is collected.

---

## Appendix A: Data Flow

```
Google Sheets (GVSI NetPulse Database)
    │
    ├── NLZ NAP Report ──────────────┐
    ├── NLZ LCP Report ──────────────┤
    ├── NLZ OLT Report ──────────────┤
    ├── OLT DOWN Tickets ────────────┤
    ├── Node DOWN Tickets ───────────┤
    └── Backbone Tickets ────────────┤
                                     │
                                     ▼
                        Apps Script (code.gs)
                        - Reads sheets
                        - Caches data (60-180s TTL)
                        - Returns JSON
                                     │
                                     ▼
                        NetPulse Web App (index.html)
                        - Fetches from Apps Script
                        - Renders tables, charts, modals
                        - Saves daily snapshots to IndexedDB
                                     │
                                     ▼
                        Analytics Dashboard
                        - Aggregates data from all modules
                        - Renders stat cards, donut charts
                        - Renders trend charts from IndexedDB
```

## Appendix B: Color Reference

| Color | Hex Code | Usage |
|-------|----------|-------|
| Teal | #0d8a80 | Primary brand, NAP, UP status |
| Green | #22c55e | <24h aging, healthy status |
| Yellow | #eab308 | 1-3 day aging, UPLINK DOWN |
| Orange | #f97316 | LOW POWER, MPLS |
| Red | #ef4444 | DOWN, >3 day aging, critical |
| Purple | #8b5cf6 | Node, DEGRADATION, DWDM |

---

**Document Version:** 1.0  
**Last Updated:** August 25, 2026  
**Maintained by:** GVSI Network Operations
