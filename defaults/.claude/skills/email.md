---
skill: email
version: 1.0
---

# Skill: email

## When to use this skill
Read this file when a story involves:
- Transactional emails — welcome, reset, confirmation
- Notification emails
- Email templates
- Email deliverability
- Unsubscribe or preference management
- Email queuing or scheduling

## Key concepts

### Transactional vs marketing
- Transactional: triggered by user action — always send
- Marketing: promotional content — requires consent and unsubscribe
- Never send marketing email to users who have not opted in
- Always provide unsubscribe in marketing emails

### Deliverability
- Use a dedicated sending domain — not your main domain
- Set up SPF, DKIM and DMARC records
- Warm up new sending domains gradually
- Monitor bounce and complaint rates
- Never send to invalid or bounced addresses again

### Email queuing
- Never send email synchronously in a request cycle
- Always queue emails and send async
- Handle send failures with retry logic
- Log every email sent with recipient and status

## Patterns and approaches

### Templates
- Use a templating system — never string concatenation
- Plain text version required alongside HTML
- Test rendering across major email clients
- Keep templates simple — email CSS support is limited
- Inline all CSS — many clients strip head styles

### Required content
- Sender name and email must be clear and recognisable
- Subject line must be honest — no clickbait
- Unsubscribe link in every marketing email
- Physical address in marketing emails where legally required
- Reply-to set to a monitored address

### Personalisation
- Use recipient name where appropriate
- Escape all user supplied content — prevent injection
- Test with edge case names — empty, very long, special characters

## Common pitfalls
- Sending email synchronously and blocking the response
- Not handling bounces and complaints
- Sending HTML only — no plain text version
- Not testing across email clients
- Hardcoding sender details — use environment config
- Not logging sent emails

## Security considerations
- Never include sensitive data in email — passwords, tokens, full card numbers
- Password reset links must expire — 1 hour maximum
- One time use links — invalidate after use
- Do not confirm whether an email address exists — prevent enumeration
- Rate limit email sending per user — prevent abuse
