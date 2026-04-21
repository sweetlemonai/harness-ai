---
standard: data-model
version: 1.0
updated:
---

# Standard: data-model

## Naming conventions
- Tables: plural snake_case — users, blog_posts, order_items
- Columns: singular snake_case — first_name, created_at
- Primary keys: always id
- Foreign keys: related_table_singular_id — user_id, post_id
- Boolean columns: prefix with is_, has_, can_ — is_active, has_verified
- Timestamp columns: suffix with _at — created_at, updated_at, deleted_at
- Junction tables: both table names joined — user_roles, post_tags
- Indexes: idx_table_column — idx_users_email

## Required columns on every table
- id — primary key
- created_at — timestamp, never null
- updated_at — timestamp, never null

## Soft deletes
- Use deleted_at timestamp instead of hard deletes where data must be preserved
- Queries must always filter deleted_at IS NULL unless explicitly querying deleted records

## Schema overview
<!-- Update with project specific schema -->

## Tables
<!-- Document each table as it is created -->

### Template
```
### table_name
| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id     | uuid | no       |         | Primary key |
| created_at | timestamp | no | now() | |
| updated_at | timestamp | no | now() | |
```

## Relationships
<!-- Document relationships between tables -->

## Seed data
<!-- Document required seed data for development and testing -->

### Required for development
<!-- Data that must exist for the app to function in dev -->

### Required for testing
<!-- Data that must exist for tests to run -->

## Migration rules
- Never modify existing migrations — create new ones
- Migration names: YYYYMMDDHHMMSS_description
- Every migration must have a rollback
- Test migrations up and down before committing
- Migrations run automatically in CI
- Production migrations require manual approval
