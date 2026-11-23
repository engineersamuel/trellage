# Rapture Top 100 research

This deliverable records what official church statements say about rapture
timing and related end-times views. It is a classification of a ranked walk,
not a survey of religious belief or a claim that a church's label captures all
teaching by its members.

## Data snapshot

- Counts by label: pre-tribulation **19**; pre-wrath **0**;
  mid-tribulation **0**; post-tribulation **0**; preterist **0**; multiple
  views permitted **5**; other eschatology **0**; premillennial (timing not
  stated) **42**; imminent return (timing not stated) **26**; rapture named
  (timing not stated) **8**.
- The 100 kept churches were reached at walk rank **442**; **342** churches
  through that rank were excluded.
- Pages-read date range: **2026-11-22 to 2026-11-22**.
- Hartford walk depth: walk ranks **101-442**, corresponding to filtered
  Hartford positions **40-452**.

## Ranking sources

- **Outreach 100 2026**:
  <https://outreach100.com/largest-churches-in-america/2026>. The metric is
  average in-person weekend attendance for February-March 2026, using the
  Lifeway survey plus Hartford public data. Its listed walk is ranks 1-100.
- **Hartford megachurch database**:
  <https://hirr.hartfordinternational.edu/research/megachurch-database/>.
  The page was updated 2026-09-29. Row years are not stated; the metric is
  described as "consistent weekly attendance." Rows are ordered by size
  descending and then church name A-Z. Canadian rows and Outreach-100
  duplicates are removed. The roster preparation removed **23 Canadian**,
  **1 Australian**, and **106 Outreach-duplicate** rows (130 removals total).
  The database was fetched on 2026-11-22 (2026-11-23 UTC). Hartford asks that
  its list not be reprinted, so this repository publishes only the rows
  reached in the walk.

Three roster locations were corrected from the original source data:
NewSpring Church is in Anderson, SC; Free Chapel is in Gainesville, GA; and
Second Baptist Church is in Houston, TX. Akron and Getzville instances of
The Chapel, and Naperville and Grand Rapids instances of Calvary Church, carry
city qualifiers in the published name so distinct churches remain distinct.

## Plain-language labels

- **pre-tribulation**: the church says the rapture comes before the
  tribulation.
- **pre-wrath**: the rapture comes during the tribulation, before God's wrath.
- **mid-tribulation**: the rapture comes in the middle of the tribulation.
- **post-tribulation**: the rapture comes after the tribulation, at or after
  Christ's visible return.
- **preterist**: the church applies a preterist view to the relevant prophecy
  or end-times events.
- **multiple views permitted**: the church explicitly allows members to hold
  several views.
- **other eschatology**: the church states another clear end-times view that
  does not fit an earlier label.
- **premillennial (timing not stated)**: it states premillennialism but not
  where the rapture falls relative to the tribulation.
- **imminent return (timing not stated)**: it says Christ can return at any
  moment but does not state rapture timing.
- **rapture named (timing not stated)**: it names the rapture but gives no
  timing relative to the tribulation.

## Keep and exclude rule

A church is kept when its own official statement, or a document that its
official beliefs page explicitly adopts or links as its statement, contains a
closed-list TERM inside an end-times passage. Words in sermons, books,
denominational summaries, or a denomination's typical view do not qualify.
Mere denominational membership is not adoption. "Wrath of God" in a
salvation-only or judgment-of-sin article is excluded because it is not an
end-times passage. A bare statement that Jesus will return is also excluded
without a listed TERM.

The full TERMS list, label precedence, and four-step search procedure are in
`rules.md`.

## Rebuild and check

Run from the repository root:

```sh
python3 research/rapture-top100/build.py
python3 research/rapture-top100/build.py --check
python3 research/rapture-top100/test_build.py
```

The first command writes `chart-counts.svg` and `chart-churches.svg`; the
check validates the CSVs, search log, SVG XML, visible chart contents, and
byte-for-byte freshness. The build is deterministic. The counts chart displays
only labels with a count greater than zero.

## What the charts show

The counts chart shows the mix of the 100 qualifying church statements: 42
state premillennialism without a rapture timing, 26 state an imminent return
without that timing, and smaller groups use the other observed labels. The
church chart lists every kept church, its walk rank, and its label; the gaps
in rank sequence are the churches excluded from the walk.

## Interpretation risks

- The ranked walk is not the plain top 100 by every church-ranking method or
  population definition.
- The ranking sources are not evangelical-only.
- Attendance is self-reported; Hartford rows are undated, and some listed
  churches may have closed.
