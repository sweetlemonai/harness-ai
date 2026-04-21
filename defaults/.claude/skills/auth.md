---
skill: auth
version: 1.0
---

# Skill: auth

## When to use this skill
Read this file when a story involves:
- User registration, login, logout
- Password reset or email verification
- Session management
- OAuth or social login
- Role based access control
- Protected routes or API endpoints
- Token handling — JWT, refresh tokens

## Key concepts

### Authentication vs authorisation
- Authentication: who are you
- Authorisation: what are you allowed to do
- Never confuse the two — check both separately

### Session management
- Use httpOnly cookies for session tokens — never localStorage
- Set secure flag on all auth cookies
- Set SameSite=Strict or Lax — never None unless required
- Session tokens must expire — never infinite sessions
- Invalidate sessions server side on logout

### Passwords
- Never store plain text passwords — ever
- Use bcrypt, argon2 or scrypt — never MD5 or SHA1
- Minimum password length: 8 characters
- Never log passwords — not even hashed

### JWT
- Short expiry on access tokens — 15 minutes max
- Longer expiry on refresh tokens — 7 days max
- Store refresh tokens in httpOnly cookies
- Rotate refresh tokens on use
- Invalidate refresh tokens on logout
- Never store sensitive data in JWT payload — it is not encrypted

### OAuth / social login
- Always validate the state parameter — prevents CSRF
- Always verify the token with the provider server side
- Never trust client side OAuth callbacks without server verification

## Patterns and approaches

### Protected routes
- Check authentication at the middleware level — not per route
- Check authorisation per resource — not per route
- Return 401 for unauthenticated, 403 for unauthorised
- Never return different errors that leak information

### Role based access control
- Define roles clearly — admin, user, guest
- Check roles server side always — never trust client
- Principle of least privilege — default to minimum access
- Log all privilege escalations

## Common pitfalls
- Storing tokens in localStorage — vulnerable to XSS
- Not invalidating sessions server side on logout
- Weak password hashing algorithms
- Not validating OAuth state parameter
- Returning 404 instead of 403 — leaks resource existence
- Trusting user supplied role data from client

## Security considerations
- Rate limit all auth endpoints — prevent brute force
- Lock accounts after N failed attempts
- Log all failed auth attempts
- Use constant time comparison for token validation
- Never expose user enumeration — same error for wrong email or password
