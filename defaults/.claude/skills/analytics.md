---
skill: analytics
version: 1.0
---

# Skill: analytics

## When to use this skill
Read this file when a story involves:
- Event tracking
- Page views or user sessions
- Conversion tracking
- Funnel analysis
- A/B testing
- Tag management
- Analytics dashboards or reporting

## Key concepts

### Event driven analytics
- Track events not just page views
- Every meaningful user action is an event
- Events have a name and optional properties
- Be consistent with naming — once set, names do not change

### Event naming convention
- Use snake_case for event names
- Format: object_action — button_clicked, form_submitted, page_viewed
- Be specific — checkout_started not just started
- Be consistent across the codebase

### Data layer
- Use a data layer object as the single source of truth
- Push events to data layer — let tag manager consume them
- Never call analytics providers directly from components
- Data layer decouples code from analytics tools

## Patterns and approaches

### What to track
- Page views — every route change
- Key interactions — CTAs, form submissions, navigation
- Conversion events — sign up, purchase, upgrade
- Error events — form errors, failed actions
- Engagement events — scroll depth, time on page for key pages

### Event properties
- Include enough context to be useful in analysis
- User id where available — anonymised or hashed
- Page or section where event occurred
- Relevant entity ids — product id, plan name
- Never include PII in event properties — names, emails, addresses

### Consent
- Respect user consent before firing analytics
- Check consent before initialising analytics tools
- Provide clear opt out mechanism
- Do not track users who have not consented

## Common pitfalls
- Inconsistent event naming across the codebase
- Including PII in event properties
- Tracking too much — data noise makes analysis hard
- Not testing events before shipping
- Firing analytics before consent is confirmed
- Direct provider calls scattered across components

## Implementation notes
- Initialise analytics once at app root
- All events go through a central tracking function
- Test events using provider debug tools before going live
- Document every event in a tracking plan
