# Rapture Top 100 research rules

These rules apply consistently to every worker and every rank in the walk.

## Source rules

1. Use the church's own official statement: a beliefs, doctrine, statement of
   faith, or position-paper page or PDF on the church's own domain.
2. An adopted denominational or network confession counts only when the
   church's own beliefs page explicitly affirms it or links it as the church's
   statement. Quote the adopted text and record both URLs.
3. Mere denominational membership is not adoption.
4. Do not use sermons, books, a denomination's typical view, third-party
   summaries, interviews, or Wikipedia to classify a church.

## Closed TERMS list and matching rule

The following list is closed. Compare it case-insensitively to the end-times
passage, accepting either a straight or curly apostrophe where an apostrophe
appears:

`rapture`, `imminent`, `imminence`, `tribulation`, `pre-tribulation`,
`pretribulation`, `pretribulational`, `mid-tribulation`, `midtribulation`,
`post-tribulation`, `posttribulation`, `posttribulational`, `pre-wrath`,
`prewrath`, `wrath of God`, `God's wrath`, `70th week`, `seventieth week`,
`Daniel's week`, `millennium`, `millennial`, `premillennial`,
`pre-millennial`, `amillennial`, `postmillennial`, `preterist`, `preterism`.

Keep a church only when one of these TERMS occurs inside a passage about the
end times. A phrase such as "wrath of God" in an article about salvation or
judgment of sin does not qualify. A bare statement that "Jesus will return"
does not qualify without a listed TERM. Record the qualifying passage
verbatim.

## Labels

Use exactly one of these labels:

| Label | Definition |
|---|---|
| `pre-tribulation` | The rapture or catching away explicitly occurs before the tribulation. |
| `pre-wrath` | The rapture occurs during the tribulation but before God's wrath. |
| `mid-tribulation` | The rapture occurs in the middle of the tribulation. |
| `post-tribulation` | The rapture occurs after the tribulation, at or after the visible return. |
| `preterist` | The statement takes a preterist view of the relevant prophetic or end-times events. |
| `multiple views permitted` | The statement explicitly permits more than one view of rapture timing or the end times. |
| `other eschatology` | The statement takes another clear end-times position outside the preceding views. |
| `premillennial (timing not stated)` | It states premillennialism but does not place the rapture relative to the tribulation. |
| `imminent return (timing not stated)` | It says Christ's return is imminent or at any moment but does not state rapture timing. |
| `rapture named (timing not stated)` | It names the rapture without stating its timing relative to the tribulation. |

When several labels could apply, use this precedence:

1. `pre-tribulation`
2. `pre-wrath`
3. `mid-tribulation`
4. `post-tribulation`
5. `preterist`
6. `multiple views permitted`
7. `other eschatology`
8. `premillennial (timing not stated)`
9. `imminent return (timing not stated)`
10. `rapture named (timing not stated)`

If an official statement neither contains a TERM in an end-times passage nor
otherwise qualifies, exclude the church rather than infer a view.

## Normalization

- Compare church names after lowercasing and stripping punctuation. Treat names
  that normalize identically as duplicates.
- Compare `statement_url` hosts after lowercasing and stripping a leading
  `www.`. Different pages on the same host are duplicates.

## Four-step search procedure

Record the result of every step:

1. **Beliefs page:** inspect the site's beliefs navigation and likely official
   beliefs, doctrine, statement-of-faith, or position-paper pages.
2. **Linked PDFs:** follow relevant PDFs linked from those official pages.
3. **Adopted confession:** inspect any confession the church explicitly says
   it affirms or adopts.
4. **Site search:** search the church's own site for the closed TERMS.

For each unsuccessful step, record a non-empty note beginning with
`none found:` and enough detail to show what was checked.

## Ranking rules

- Ranks 1-100 come from Outreach 100 2026. Set `ranking_source` to
  `Outreach 100 2026` and preserve the Outreach rank as `source_rank`.
- Continue the walk with the Hartford megachurch database. Sort by size
  descending, breaking ties by church name A-Z. Remove Canadian rows and
  duplicates of the Outreach 100. Each remaining row's walk rank is
  `100 + position`, with `source_rank` equal to its positive position in that
  filtered, sorted Hartford list. Set `ranking_source` to `Hartford`.

## Disputed-label rulings

Data workers may append reviewed rulings here.
