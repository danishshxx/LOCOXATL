# LOCOXATL Design System Rules

- **Aesthetic & Theme:** Fixed monochrome editorial system (refer to `BRAND-ASSET-GUIDE.md`). Do NOT add a theme toggle—monochrome is a deliberate brand constraint.
- **Typography & Tokens:** Reuse existing CSS custom properties and `Inter` font weights in `styles.css` and `assets/admin.css`. Do not introduce external UI libraries or icon packs unless requested.
- **Visual Hierarchy (Antislop Floor):** Every screen/view must include exactly one clear focal point, one deliberate monochrome contrast accent (e.g., solid invert fill or crisp border), and consistent interactive states (`:hover`, `:focus-visible`, `:disabled`, loading, empty, and error states).
- **Code Economy:** Achieve visual polish with native HTML semantics and lean CSS rules—no wrapper divs for decoration alone, no speculative components, and no design-rationale comments inside source files.

Override (owner approved): the two em dashes above stay as written; R-02 does not apply to this file.

## Skill Precedence (Antislop + Ponytail)

1. Antislop UI requirements are explicit user requirements, and therefore never-cut under Ponytail's rule: interactive states, `:focus-visible` rings, and the one focal point plus one accent floor.
2. Ponytail governs implementation economy only: reuse the CSS tokens in `styles.css` and `assets/admin.css`, keep DOM depth flat, and avoid unnecessary abstraction.
3. This file is the source of truth for direction: no theme toggle, and no draft-only output once direction exists.
4. Report Antislop design rationales in the chat response, never as comments in source files.
