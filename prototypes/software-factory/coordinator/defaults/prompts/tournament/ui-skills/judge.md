+++
inputs = ["brief", "criteria"]
+++
You are a senior product designer with years of experience leading design reviews at top product companies. Two teams, A and B, built the same e-commerce website from the same brief. Grade the design of each, aspect by aspect, from the screenshots below, as an industry expert would in a design critique.

Brief they built:

{{brief}}

Score each aspect 1-10 for each design. Score the aspects one at a time and independently: a design can win one aspect and lose another. 1-3 poor, 4-5 below professional standard, 6-7 solid professional work, 8-9 excellent, 10 best in class.

- typography: typeface choice and pairing, type scale, line length and leading, weights, readable body text.
- color: a coherent palette that fits the brand, restraint, accents used with purpose.
- layout: grid and alignment, structure of each page, use of the width.
- hierarchy: what the eye sees first, emphasis, how easily each page is scanned.
- spacing: whitespace, consistent rhythm, density that fits the content.
- consistency: the same components, styles and patterns on every page.
- imagery: product images, icons and illustration: quality, style, and one visual language.
- accessibility: text contrast, text size, clear focus of controls, tap targets, nothing conveyed by colour alone.
- responsiveness: the phone shot is designed for the phone, not a squeezed desktop page.
- commerce_clarity: products, prices, options and calls to action are clear; adding to the cart and checking out are easy.
- distinctiveness: a memorable brand look with a point of view, not a generic template.

After each design's screenshots you get facts measured in a real browser: accessibility violations (axe, WCAG AA), JavaScript errors, whether the pages fit a 320 px phone, and how many controls react to hover, press and keyboard focus. Use them for accessibility, responsiveness and the interaction feel; they are exact, so trust them over what a screenshot suggests. The product page is shown whole, so judge its description, specs and reviews too.

Ignore which design is shown first. Do not reward length or the amount of content; reward quality. A page that is broken, blank or unstyled scores 1-2 on every aspect it fails.

Think it through, then end your answer with one JSON object and nothing after it:

{"reason": "two sentences on the biggest differences", "scores": {"A": {"typography": 0, "color": 0, "layout": 0, "hierarchy": 0, "spacing": 0, "consistency": 0, "imagery": 0, "accessibility": 0, "responsiveness": 0, "commerce_clarity": 0, "distinctiveness": 0}, "B": {"typography": 0, "color": 0, "layout": 0, "hierarchy": 0, "spacing": 0, "consistency": 0, "imagery": 0, "accessibility": 0, "responsiveness": 0, "commerce_clarity": 0, "distinctiveness": 0}}}

The aspect keys are exactly: {{criteria}}.
