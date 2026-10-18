---
schemaVersion: 2
templates:
  critique-visualization: |-
    Use the tufte-critique skill to evaluate {{intent}}. Report the rubric
    scores, lie-factor concerns, chartjunk, genre alternatives, and
    prioritized remedies.
  critique-and-rebuild: |-
    Use the tufte-critique skill to diagnose {{intent}}, then use the
    tufte-chart skill to rebuild the graphic as a static SVG or offline HTML
    artifact. Preserve the data and state any unsupported chart requirement.
  build-tufte-chart: |-
    Use the tufte-chart skill to create {{intent}}. Choose the chart genre
    before rendering, prefer a table for 20 or fewer numbers when it is
    clearer, and save the finished artifact in the current worktree.
  adjust-monetary-series: |-
    Use the tufte-chart skill for {{intent}}. Obtain real CPI values for
    every year, use the bundled deflate.py helper without guessing missing
    values, label the base-year currency, and render the adjusted series.
  publish-offline-html: |-
    Use the tufte-chart skill to complete {{intent}}. Produce an inert SVG,
    wrap it with the bundled wrap_html.py workflow, and report the HTML,
    SVG, and local asset paths.
  compare-many-series: |-
    Use the tufte-chart skill for {{intent}}. Render shared-scale small
    multiples and, when useful, an overplotted directly labeled alternative
    so the user can compare the two forms.
  compare-distributions: |-
    Use the tufte-chart skill for {{intent}}. Render the supported quartile
    plot and, when the data warrants it, a strip-plot or histogram
    alternative. Explain what each form reveals.
  build-range-frame-scatter: |-
    Use the tufte-chart skill for {{intent}}. Render a range-frame scatter
    and add the dot-dash marginal variant when it helps explain the
    distributions. Keep the SVG inert and directly labeled.
---

# Native Copilot CLI (`copilot`) - `tufte-vdqi` profile

`trx run copilot tufte-vdqi` is a data-visualization specialist for critiquing and
rebuilding quantitative graphics with Edward Tufte's VDQI principles. It
provides the `tufte-critique` and `tufte-chart` skills from
`gnurio/tufte-vdqi-plugin` in an isolated Copilot profile home.

## Usage

Set up the profile once:

```bash
trx setup copilot tufte-vdqi
```

Open the Trellage picker and describe the visualization outcome:

```bash
mise run trx
```

Or launch the profile directly:

```bash
trx run copilot tufte-vdqi --prompt \
  'Use tufte-critique to assess ./chart.svg and rank the fixes.'

trx run copilot tufte-vdqi --prompt \
  'Use tufte-chart to plot 2023 revenue 12.1 and 2024 revenue 15.4 as revenue.svg.'
```

Paths are relative to the directory where you start `copilot`. Ask the agent to
create the input data when you do not already have a data file.

## Use This Profile When

- You need a structured critique of a quantitative chart using Tufte-specific
  criteria and named remedies.
- You want a static SVG time series, small multiples, quartile plot, or
  range-frame scatterplot.
- You want to convert a generated SVG into an offline HTML file with local
  Tufte CSS assets.

## Avoid This Profile When

- You need an interactive dashboard, production chart component, or general
  plotting library.
- You need PNG or PDF export, browser screenshots, or visual regression tests.
- You need a deterministic image-analysis engine. The critique is an agent
  workflow, not computer vision.
- You need an approval pause. `copilot` launches with
  `--autopilot --allow-all --no-ask-user`.

## Workflow Notes

- `tufte-critique` evaluates an existing graphic and recommends changes.
- `tufte-chart` supplies deterministic Python renderers for four chart
  families and can wrap SVG output in offline HTML.
- Ask for JSON input and an SVG output path when you want the most repeatable
  renderer path.
- Other chart families can require model-authored SVG and are less
  deterministic.

## Common Workflows

These workflows summarize the upstream
[Common workflows](https://github.com/gnurio/tufte-vdqi-plugin#common-workflows)
for `copilot` and `trx` users.

| Intent | Result |
| --- | --- |
| Assess an existing chart | Nine-criterion critique, lie-factor check, named chartjunk, ranked genre choices, and prioritized fixes |
| Repair a misleading or cluttered chart | Critique first, then rebuild with the recommended Tufte remedies |
| Design a chart from structured data | A suitable static SVG genre, or a compact table when the data is better shown as numbers |
| Plot money across years | CPI-adjusted real values followed by a clearly labeled time-series chart |
| Publish a shareable page | Inert SVG wrapped in offline HTML with local Tufte typography assets |
| Compare many series | Shared-scale small multiples, with a directly labeled overlay when both views help |
| Compare group distributions | A stripped-down quartile plot, with a strip plot or histogram alternative when useful |
| Show a bivariate relationship | A range-frame scatterplot, optionally with dot-dash marginal distributions |

## Gotchas

- This is a host-native profile. It isolates Copilot state, but it is not a
  container or security boundary.
- The scripts require Python 3 but no third-party Python packages.
- The upstream project has no root license as of this profile's addition.
  Trellage links to the marketplace and does not vendor its source.
