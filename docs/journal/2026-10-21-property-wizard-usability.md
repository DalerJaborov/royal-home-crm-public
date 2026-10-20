# Property creation form usability

Scope: the existing property wizard only. Its shared font, color tokens, horizontal desktop sections, mobile layout, API payloads and draft lifecycle remain the foundation.

Changes:
- Desktop property types have familiar icons with text; required numeric inputs are marked using the existing type/private-mode rules.
- Short optional choices remain visible with an explicit clear action; longer lists retain every existing value. Plain-language bathroom/balcony labels do not change stored enums.
- Groups have one keyboard Tab entry and support arrows/Home/End. Address and landmark suggestions support keyboard selection, Escape and touch/mouse clicks without the blur timer race.
- Errors are connected to inputs; blocked navigation focuses the first invalid input. Numeric validation rejects fractional counts before the server does, while decimal areas and negative floors remain valid.
- Restored seller IDs resolve their own card even with an empty seller-list cache. Loading/error states do not masquerade as a blank new-seller form.
- Final review includes seller identity, window count, documents, landmark and selected characteristics. Required missing values are distinguished from optional omissions.

Local validation: wizard unit tests, TypeScript and scoped ESLint. Browser checks cover desktop 1440/1024 and mobile 390 widths, conditional fields, optional clearing, keyboard suggestions, seller restoration and review. The browser preview renders the real components with isolated fixtures; persistence, uploads, external map reliability and production are separate checks. No deployment was performed for this refinement.
