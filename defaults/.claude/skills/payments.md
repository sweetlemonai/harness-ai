---
skill: payments
version: 1.0
---

# Skill: payments

## When to use this skill
Read this file when a story involves:
- Payment processing
- Subscription management
- Invoicing or receipts
- Refunds or disputes
- Pricing or plan changes
- Payment method management
- Webhook handling from payment providers

## Key concepts

### Never handle raw card data
- Never let card numbers touch your server
- Use payment provider hosted fields or SDKs
- PCI compliance requires it — no exceptions

### Payment flow
- Always create payment intent server side
- Never trust client side payment confirmation
- Verify payment status server side via webhook
- Do not fulfil orders based on client confirmation alone

### Idempotency
- All payment operations must be idempotent
- Use idempotency keys on every API call
- Duplicate webhook events are normal — handle them gracefully
- Check payment status before processing — never assume

### Webhooks
- Verify webhook signatures — never process unsigned webhooks
- Respond with 200 immediately — process async
- Store raw webhook payload before processing
- Handle all relevant event types — not just success
- Log every webhook received and its outcome

## Patterns and approaches

### Subscription management
- Store subscription status locally — do not query provider on every request
- Sync status via webhooks — keep local state updated
- Handle all subscription states: active, past_due, cancelled, trialing
- Grace period for past_due before restricting access

### Refunds
- Always process refunds via provider API — never manually
- Log every refund with reason
- Update local records immediately after refund confirmation
- Notify user on successful refund

### Failed payments
- Retry logic must match provider retry schedule
- Notify user before access is restricted
- Provide clear path to update payment method
- Log all failed payment attempts

## Common pitfalls
- Processing webhooks synchronously and timing out
- Not verifying webhook signatures
- Fulfilling orders on client side confirmation
- Not handling duplicate webhook events
- Not testing with provider test mode thoroughly
- Hardcoding prices — always pull from provider or database

## Security considerations
- Never log card numbers, CVV or full PAN
- Encrypt sensitive payment metadata at rest
- Restrict payment API keys to minimum required permissions
- Use separate API keys for test and production
- Rotate API keys regularly
- Never expose secret keys client side
