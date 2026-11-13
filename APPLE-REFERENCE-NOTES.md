# Apple iPhone 18 Pro — Design Reference Notes for locoxatl

Reference page: https://www.apple.com/iphone-18-pro/

These notes describe the visible information architecture and visual patterns observed on Apple's iPhone 18 Pro product page. They are a design study, not a copy of Apple's source code, copywriting, product imagery, or brand assets.

## 1. Page architecture observed

1. **Global navigation** — compact brand navigation at the top of the page.
2. **Product navigation** — a second, product-specific navigation row with section links and a prominent purchase action.
3. **Hero statement** — product name, short positioning line, primary action, and a large product visual.
4. **Highlights** — a quick overview of the main selling points before the detailed product story.
5. **Design chapter** — a dedicated section for exterior design, finishes, color choices, sizes, and durability.
6. **Feature chapters** — individual sections that explain one capability at a time, supported by large visuals and short copy.
7. **Performance and battery chapters** — technical details presented as concise claims with supporting visual explanations.
8. **Comparison** — a structured way to compare the current product against older models.
9. **Buying support** — accessories, trade-in, payment options, delivery, guided shopping, and store support.
10. **Closing discovery** — related products, environmental information, privacy, and accessibility.

## 2. Visual language

- Large, tightly tracked sans-serif headlines establish the hierarchy.
- Short supporting paragraphs use muted gray rather than competing with the headline.
- Product visuals receive substantial space and are often isolated against simple backgrounds.
- Light and dark chapters create visual pacing across a long page.
- The product remains the focal point; decoration and interface chrome stay restrained.
- Product details are shown through close-up imagery and large-scale compositions rather than dense explanatory panels.
- Repeated section patterns make the page easy to scan without making every section look identical.
- Navigation stays compact and provides direct access to key product sections.

## 3. Interaction patterns observed or inferred from visible controls

- A persistent product-level navigation row supports movement between long-page sections.
- The highlights area provides a fast route into the product story.
- Color and model controls let visitors inspect product variants.
- A spatial product-viewing affordance is presented for examining the product in context.
- Comparison controls support product evaluation.
- Calls to action are repeated at relevant points instead of being limited to the hero.

The page's exact animation timings, scroll thresholds, and internal implementation are not specified in this document. The locoxatl prototype uses its own CSS transitions, reveal-on-scroll behavior, horizontal scroll-snap cards, and interactive configurator.

## 4. How the patterns are translated to locoxatl

| Apple page pattern | locoxatl adaptation |
|---|---|
| Product sub-navigation | Sticky locoxatl section navigation: Highlights, Design, Custom Studio, Collection |
| Cinematic product hero | Full-bleed black hero, oversized Inter headline, original keychain illustration |
| Get the highlights | Three swipeable highlight cards: Base, Details, Finish |
| Product design chapter | Monochrome chapter about acrylic, polished metal, and modular construction |
| Color/model controls | Existing Base Charm, Add-on, Clasp, and initial selections in Custom Studio |
| Product comparison and details | Clear component descriptions and live price calculation |
| Accessories and buying support | Curated collection, quick-add, shopping bag, and demo checkout |
| Closing discovery | Brand story and final create-your-own call to action |

## 5. Locoxatl visual constraints

- Typeface: Inter only.
- Palette: black, white, and neutral grays only.
- Product art: original locoxatl SVG illustrations; no Apple product images or logos.
- Motion: restrained, smooth, and responsive; reduced-motion preference is respected.
- Layout: mobile-first, with a horizontal swipe rail on narrow screens and multi-column layouts on desktop.

## 6. Implementation status

Implemented in this preview:

- Sticky global and product navigation.
- Cinematic monochrome hero.
- Swipeable highlights rail.
- Product design/material chapter.
- Interactive 2D Custom Studio with live preview and price calculation.
- Filterable product collection and quick-add actions.
- Brand story, closing CTA, cart drawer, and demo checkout.

Still required before production:

- Original product photography or approved 3D renders.
- Real inventory and product data.
- Backend/database and admin dashboard.
- Server-side price validation and persistent orders.
- Official QRIS asset, manual payment-verification process, and WhatsApp integration.
- Shipping rates, policies, and legal/privacy content.
