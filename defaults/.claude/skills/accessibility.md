---
skill: accessibility
version: 1.0
---

# Skill: accessibility

## When to use this skill
Read this file when a story involves:
- Any UI component or page
- Forms and inputs
- Navigation and menus
- Modals, drawers or overlays
- Images, icons or media
- Colour and contrast
- Keyboard interactions
- Error messages or notifications

## Key concepts

### WCAG 2.1 AA compliance
- This is the minimum standard — not optional
- Level AA covers the most common accessibility requirements
- Test with real assistive technology — not just automated tools
- Automated tools catch approximately 30% of issues — manual testing required

### The four principles — POUR
- Perceivable: users can perceive all content
- Operable: users can operate all interactions
- Understandable: content and UI are understandable
- Robust: works with current and future assistive technologies

## Patterns and approaches

### Keyboard navigation
- Every interactive element must be keyboard accessible
- Tab order must be logical — follows visual order
- Focus must always be visible — never hide outline without replacement
- Modals must trap focus while open
- Escape key closes modals and drawers
- Skip to main content link at top of every page

### Semantic HTML
- Use the right element for the job — button not div with onclick
- Heading hierarchy must be logical — never skip levels
- Lists for list content — nav, ul, ol
- Tables for tabular data only — with proper headers
- Landmarks: header, main, nav, footer, aside

### Forms
- Every input must have a visible label — not just placeholder
- Label must be programmatically associated — for attribute or aria-labelledby
- Error messages must be associated with the field — aria-describedby
- Required fields must be indicated — not by colour alone
- Group related fields with fieldset and legend

### Images and media
- Decorative images: alt=""
- Informative images: descriptive alt text
- Complex images: long description alongside
- Never use images of text
- Video must have captions
- Audio must have transcript

### Colour and contrast
- Text contrast minimum 4.5:1 against background
- Large text minimum 3:1
- UI components and focus indicators minimum 3:1
- Never use colour as the only way to convey information
- Test designs in greyscale

### ARIA
- Use native HTML semantics first — ARIA is a last resort
- aria-label for elements with no visible text
- aria-describedby for supplementary descriptions
- aria-live for dynamic content updates
- aria-expanded for toggleable elements
- Never add ARIA that conflicts with native semantics

## Common pitfalls
- Click events on non-interactive elements — divs and spans
- Missing focus styles
- Colour contrast failures
- Missing form labels
- Inaccessible modals — no focus trap, no escape key
- Auto-playing media
- Timeout warnings with no way to extend
- Empty or meaningless alt text — alt="image" is worse than alt=""

## Testing approach
- Automated: run axe or similar on every page
- Keyboard: tab through entire page — can you do everything without a mouse
- Screen reader: test with VoiceOver or NVDA on key flows
- Zoom: test at 200% zoom — content must not break
- Colour: test with colour blindness simulator
