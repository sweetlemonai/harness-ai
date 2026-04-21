---
skill: seo
version: 1.0
---

# Skill: seo

## When to use this skill
Read this file when a story involves:
- Page titles or meta descriptions
- Headings and content structure
- URLs and routing
- Structured data or schema markup
- Sitemaps or robots.txt
- Open Graph or social sharing
- Page performance affecting SEO
- Internal linking

## Key concepts

### Technical SEO fundamentals
- Every page needs a unique, descriptive title tag — 50-60 characters
- Every page needs a meta description — 150-160 characters
- One H1 per page — describes the page content clearly
- Heading hierarchy must be logical — H1 then H2 then H3
- URLs must be clean, descriptive and lowercase with hyphens
- Canonical tags on duplicate or paginated content
- Noindex on pages that should not be crawled

### Performance and SEO
- Core Web Vitals directly affect rankings
- LCP under 2.5 seconds
- CLS under 0.1
- INP under 200ms
- Images must have descriptive alt text — not just for SEO but accessibility
- Lazy load below the fold images

### Structured data
- Use JSON-LD for structured data — not microdata
- Add relevant schema types — Article, Product, BreadcrumbList, FAQPage
- Test with Google Rich Results Test before shipping
- Do not mark up content that is not visible on the page

## Patterns and approaches

### Title tags
- Primary keyword near the start
- Brand name at the end — separated by pipe or dash
- Unique per page — never duplicate
- Descriptive and honest — matches page content

### Meta descriptions
- Include primary keyword naturally
- Write for humans first — it is a call to action in search results
- Unique per page
- Never auto-generated from first paragraph — write intentionally

### URL structure
- Lowercase always
- Hyphens not underscores
- Descriptive not id based — /blog/how-to-do-x not /blog/12345
- Short as possible while still descriptive
- Consistent structure across the site

### Open Graph
- og:title, og:description, og:image, og:url required on every page
- og:image minimum 1200x630px
- Twitter card tags alongside Open Graph

## Common pitfalls
- Duplicate title tags across pages
- Missing alt text on images
- Broken internal links
- Blocking CSS or JS in robots.txt
- Slow page speed — Core Web Vitals failures
- Thin or duplicate content
- Missing canonical tags on paginated or filtered pages

## Copywriter and SEO
- Copywriter handles: titles, meta descriptions, headings, body content
- Coder handles: technical implementation, schema markup, performance
- Both responsible: URL structure, heading hierarchy, internal linking
