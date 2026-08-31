---
schemaVersion: 1
capabilities:
  - tufte-vdqi-chart-critique
  - lie-factor-and-chartjunk-analysis
  - chart-genre-selection
  - static-svg-chart-generation
  - time-series-small-multiples-quartile-range-frame
  - inflation-adjusted-monetary-series
  - offline-tufte-html-publishing
  - autopilot-no-ask-user-launch
  - isolated-copilot-home
bestFor:
  - Scoring an existing chart, graph, plot, or dashboard against Tufte principles with concrete evidence and prioritized remedies
  - Detecting misleading scales, lie factor, chartjunk, weak data-ink ratio, redundant encoding, and poor chart-genre choices
  - Rebuilding a cluttered or misleading quantitative graphic as a publication-ready static SVG or offline HTML artifact
  - Creating time series, small multiples, quartile plots, and range-frame scatterplots from structured data
  - Adjusting monetary time series with real CPI values before plotting or publishing them
avoidFor:
  - Interactive dashboards, application-integrated chart components, or exploratory plotting systems
  - Tasks that require PNG or PDF export, browser-driven visual regression, or a broad statistical chart grammar
  - Sessions that need an approval pause; every launch passes --autopilot --allow-all --no-ask-user
prerequisites:
  - id: copilot-cli
    description: GitHub Copilot CLI 1.0.74 or later, already authenticated, on the host.
  - id: cli-tools
    description: Python 3, jq, and curl available on the host for rendering, setup, doctor, and update checks.
workflows:
  - id: critique-visualization
    description: Score an existing chart, graph, plot, or dashboard with the nine-criterion VDQI rubric and return named, prioritized remedies.
    skill: tufte-critique
    examples:
      - Is this chart misleading, cluttered, or using the wrong visual form?
      - Score this dashboard graphic for lie factor, chartjunk, data-ink ratio, and labeling
    promptTemplate: |
      Use the tufte-critique skill to evaluate {{intent}}. Report the rubric
      scores, lie-factor concerns, chartjunk, genre alternatives, and
      prioritized remedies.
  - id: critique-and-rebuild
    description: Critique an existing quantitative graphic, then rebuild it as a clearer static SVG with the Tufte chart workflow.
    skill: tufte-critique
    examples:
      - Diagnose this cluttered chart and rebuild it with direct labels and less non-data ink
      - Explain why this graph is misleading, then replace it with a more honest static visualization
    promptTemplate: |
      Use the tufte-critique skill to diagnose {{intent}}, then use the
      tufte-chart skill to rebuild the graphic as a static SVG or offline HTML
      artifact. Preserve the data and state any unsupported chart requirement.
  - id: build-tufte-chart
    description: Choose a suitable Tufte chart genre and create a publication-ready static SVG or offline HTML artifact from structured data.
    skill: tufte-chart
    examples:
      - Design a Tufte-style chart from these quantitative values and save the SVG
      - Visualize this small dataset, but use a table if that communicates the numbers more clearly
    promptTemplate: |
      Use the tufte-chart skill to create {{intent}}. Choose the chart genre
      before rendering, prefer a table for 20 or fewer numbers when it is
      clearer, and save the finished artifact in the current worktree.
  - id: adjust-monetary-series
    description: Convert a multi-year currency series to real terms with verified CPI values, then render an accurately labeled time-series chart.
    skill: tufte-chart
    examples:
      - Adjust this revenue history for inflation and chart it in real 2025 dollars
      - Compare these annual prices without letting nominal currency changes distort the trend
    promptTemplate: |
      Use the tufte-chart skill for {{intent}}. Obtain real CPI values for
      every year, use the bundled deflate.py helper without guessing missing
      values, label the base-year currency, and render the adjusted series.
  - id: publish-offline-html
    description: Wrap a generated SVG in a shareable offline HTML page with bundled Tufte typography and no network dependency.
    skill: tufte-chart
    examples:
      - Turn this chart into a self-contained Tufte-styled page I can open offline
      - Publish the SVG with a title and caption as portable HTML
    promptTemplate: |
      Use the tufte-chart skill to complete {{intent}}. Produce an inert SVG,
      wrap it with the bundled wrap_html.py workflow, and report the HTML,
      SVG, and local asset paths.
  - id: compare-many-series
    description: Compare many related series with shared scales, usually as ordered small multiples instead of an unreadable overplot.
    skill: tufte-chart
    examples:
      - Compare these regional time series as shared-scale small multiples
      - Replace this crowded multi-line chart with a clearer set of comparable panels
    promptTemplate: |
      Use the tufte-chart skill for {{intent}}. Render shared-scale small
      multiples and, when useful, an overplotted directly labeled alternative
      so the user can compare the two forms.
  - id: compare-distributions
    description: Compare distributions across groups with a stripped-down quartile plot and an optional strip-plot or histogram alternative.
    skill: tufte-chart
    examples:
      - Compare these treatment distributions with Tufte quartile plots
      - Show the spread and medians for these groups without conventional box-plot clutter
    promptTemplate: |
      Use the tufte-chart skill for {{intent}}. Render the supported quartile
      plot and, when the data warrants it, a strip-plot or histogram
      alternative. Explain what each form reveals.
  - id: build-range-frame-scatter
    description: Plot bivariate data with axes limited to the observed range and optional dot-dash marginal distributions.
    skill: tufte-chart
    examples:
      - Make a range-frame scatterplot for these two variables
      - Add dot-dash marginals so this scatterplot also shows each variable's distribution
    promptTemplate: |
      Use the tufte-chart skill for {{intent}}. Render a range-frame scatter
      and add the dot-dash marginal variant when it helps explain the
      distributions. Keep the SVG inert and directly labeled.
---

# Native Copilot CLI (`cpx`) - `tufte-vdqi` profile

`cpx tufte-vdqi` is a data-visualization specialist for critiquing and
rebuilding quantitative graphics with Edward Tufte's VDQI principles. It
provides the `tufte-critique` and `tufte-chart` skills from
`gnurio/tufte-vdqi-plugin` in an isolated Copilot profile home.

## Usage

Set up the profile once:

```bash
cpx setup tufte-vdqi
```

Open the Trellage picker and describe the visualization outcome:

```bash
mise run trx
```

Or launch the profile directly:

```bash
cpx tufte-vdqi --prompt \
  'Use tufte-critique to assess ./chart.svg and rank the fixes.'

cpx tufte-vdqi --prompt \
  'Use tufte-chart to plot 2023 revenue 12.1 and 2024 revenue 15.4 as revenue.svg.'
```

Paths are relative to the directory where you start `cpx`. Ask the agent to
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
- You need an approval pause. `cpx` launches with
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
for `cpx` and `trx` users.

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
