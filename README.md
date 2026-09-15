# Mock Backend VIR

A backend service for equipment inspection workflows with job card management, media handling, and signature capture.

## Prerequisites

- **Node.js** 18+ and npm
- **Docker** and Docker Compose
- **PostgreSQL** 16 (handled via Docker)

## Quick Start

### 1. Setup Environment

Copy the example environment file and customize as needed:

```bash
cp .env.example .env
```

Default values in `.env.example` are ready for development:

- Database: `mock_backend_vir`
- Port: `3000`
- Default superuser: `admin@example.com` (password: `change-me`)

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Docker Services

Start PostgreSQL in Docker:

```bash
docker-compose up -d
```

Verify the database is running:

```bash
docker-compose ps
```

### 4. Run Database Migrations

Apply all pending migrations to create the schema:

```bash
npm run migrate
```

This will:

- Create the `schema_migrations` table (if it doesn't exist)
- Apply all `.sql` files from the `migrations/` directory in order
- Track applied migrations to prevent re-running

### 5. Seed Initial Data

Create a superuser account for authentication:

```bash
npm run seed
```

This uses `SEED_SUPERUSER_EMAIL` and `SEED_SUPERUSER_PASSWORD` from your `.env` file.

### 6. Start Development Server

```bash
npm run dev
```

The server will start on `http://localhost:3000` with hot-reload enabled.

---

## Database Management

### View Database Migrations

All migrations are stored in the `migrations/` directory as numbered SQL files:

```
migrations/
├── 001_init.sql
├── 002_users_and_refresh_tokens.sql
├── 003_app_config.sql
├── 004_equipment_inspection_schema.sql
├── 005_add_slug_id_column.sql
├── 006_equipment_type_models.sql
├── 007_depots.sql
├── 008_job_cards.sql
├── 009_job_number_format.sql
├── 010_media.sql
├── 011_signatures.sql
└── 012_inspection_items.sql
```

### Reset Database

To completely reset your local database:

```bash
docker-compose down -v
docker-compose up -d
npm run migrate
npm run seed
```

The `-v` flag removes volumes, ensuring a fresh start.

### Connect to Database

Access PostgreSQL directly:

```bash
docker exec -it mock-backend-vir-db psql -U postgres -d mock_backend_vir
```

---

## Legacy Data Migration

If you have legacy SQLite data, follow these steps to migrate to the new PostgreSQL schema:

### Prerequisites

- Raw SQLite database file (`.db` or similar)
- Legacy data structure documented in `legacy_data/`

### Migration Process

#### Step 1: Prepare the Database

Ensure PostgreSQL is running with all migrations applied:

```bash
npm run migrate
```

#### Step 2: Run Legacy Data Migration

```bash
npm run migrate:legacy-data
```

This script will:

- Read data from the legacy SQLite database
- Transform and map it to the new schema
- Resolve foreign key relationships
- Handle data integrity issues (documented in `legacy_data/migration-exceptions.md`)
- Insert data into PostgreSQL tables

#### Step 3: Verify Migration

After migration completes, verify data integrity:

```bash
npm run verify:legacy-migration
```

This generates a report of any exceptions or issues encountered during migration (stored in
`legacy_data/migration-exceptions.md`).

### Additional Migration Scripts

- **Backfill Depots**: If depots weren't migrated properly:
  ```bash
  npm run backfill:depots
  ```

- **Regenerate Slug IDs**: Reset slug-based IDs:
  ```bash
  npm run regenerate:slug-ids
  ```

- **Cleanup Media**: Remove orphaned media files:
  ```bash
  npm run reap:media
  ```

---

## Running Tests

### Run All Tests

```bash
npm test
```

Tests use a separate test database (`mock_backend_vir_test`) to avoid affecting development data.

### Run Specific Test File

```bash
npm test -- tests/jobCards.schema.test.ts
```

---

## Available Scripts

| Command                           | Description                              |
|-----------------------------------|------------------------------------------|
| `npm run dev`                     | Start development server with hot-reload |
| `npm run build`                   | Compile TypeScript to JavaScript         |
| `npm start`                       | Run compiled application                 |
| `npm run migrate`                 | Apply pending database migrations        |
| `npm run migrate:legacy-data`     | Migrate data from legacy SQLite database |
| `npm run verify:legacy-migration` | Verify legacy migration success          |
| `npm run seed`                    | Create initial superuser account         |
| `npm run regenerate:slug-ids`     | Reset slug-based IDs                     |
| `npm run backfill:depots`         | Backfill depot associations              |
| `npm run reap:media`              | Cleanup orphaned media files             |
| `npm run lint`                    | Check code style with ESLint             |
| `npm run lint:fix`                | Auto-fix code style issues               |
| `npm test`                        | Run test suite                           |
| `npm run type-check`              | Check TypeScript types without compiling |

---

## Project Structure

```
.
├── migrations/           # Database schema migrations (SQL files)
├── scripts/             # Utility scripts (migrate, seed, etc.)
├── src/
│   ├── db/             # Database connection and repositories
│   ├── schemas/        # Zod validation schemas
│   ├── routes/         # API endpoints
│   └── index.ts        # Express app entry point
├── tests/              # Test suite
├── legacy_data/        # Legacy data migration documentation
├── docker-compose.yml  # Docker services configuration
├── .env.example        # Environment variables template
└── package.json        # Dependencies and scripts
```

---

## Environment Variables

Key variables in `.env`:

| Variable                  | Description                          | Default              |
|---------------------------|--------------------------------------|----------------------|
| `PORT`                    | Server port                          | `3000`               |
| `NODE_ENV`                | Environment (development/production) | `development`        |
| `POSTGRES_USER`           | Database user                        | `postgres`           |
| `POSTGRES_PASSWORD`       | Database password                    | `postgres`           |
| `POSTGRES_DB`             | Database name                        | `mock_backend_vir`   |
| `POSTGRES_PORT`           | Database port                        | `5432`               |
| `DATABASE_URL`            | Connection string                    | See `.env.example`   |
| `TEST_DATABASE_URL`       | Test database URL                    | See `.env.example`   |
| `JWT_SECRET`              | Secret for JWT signing               | `change-me`          |
| `SEED_SUPERUSER_EMAIL`    | Initial admin email                  | `admin@example.com`  |
| `SEED_SUPERUSER_PASSWORD` | Initial admin password               | `change-me`          |
| `STORAGE_ROOT`            | GLB file storage path                | `./storage`          |
| `GLB_MAX_BYTES`           | Max GLB upload size                  | `104857600` (100 MB) |
| `GLB_URL_TTL_SECONDS`     | Signed URL validity period           | `900` (15 min)       |

---

## Troubleshooting

### Database Connection Failed

```bash
# Check if PostgreSQL is running
docker-compose ps

# View logs
docker-compose logs postgres

# Restart services
docker-compose restart
```

### Migrations Not Applying

```bash
# Check if schema_migrations table exists
docker exec -it mock-backend-vir-db psql -U postgres -d mock_backend_vir -c "SELECT * FROM schema_migrations;"

# Manually check migration status
npm run migrate
```

### Test Database Issues

Ensure `TEST_DATABASE_URL` points to a different database than `DATABASE_URL`. Tests automatically truncate tables
between runs.

```bash
# Create test database if it doesn't exist
docker exec -it mock-backend-vir-db createdb -U postgres mock_backend_vir_test
```

---

## API Documentation

Swagger API documentation is available at:

```
http://localhost:3000/api-docs
```

---

## Contributing

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make changes and test: `npm test`
3. Lint your code: `npm run lint:fix`
4. Commit with clear messages
5. Push and open a pull request

---

## License

ISC
