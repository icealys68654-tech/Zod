# Zod

Zod is a TypeScript-first schema validation library. It lets developers define schemas for data and validate values at runtime while inferring corresponding TypeScript types.

## Why use Zod?

The core idea is to describe the expected shape of data once and then use that schema at application boundaries such as:

- API requests
- Configuration loading
- Form submissions

Validation produces either parsed, typed data or structured errors that can be reported back to the caller.

## Quick start

Install the package with npm:

```bash
npm install zod
```

Then define a schema and parse input:

```ts
import { z } from "zod";

const UserSchema = z.object({
  id: z.string(),
  age: z.number().min(18),
  email: z.string().email()
});

const result = UserSchema.parse({
  id: "u_123",
  age: 21,
  email: "user@example.com"
});

console.log(result.id);
```

If the input does not match the schema, Zod throws a validation error with details that make it easy to debug.

## Makefile workflow

This repository includes a `Makefile` for common Node.js tasks, including:

- `make install` — install dependencies
- `make build` — build the project
- `make test` — run the test suite
- `make lint` — run linting checks
- `make clean` — remove build artifacts

These targets assume matching npm scripts are defined in `package.json`.

## Project structure

The repository is organized around a Node.js project setup with a small set of developer-facing files:

- `Makefile` for development commands
- `package.json` for project scripts and dependencies
- application/server files for runtime behavior
- documentation files such as `README.md` and `Abstract.txt`

## Summary

Zod helps teams validate inputs consistently, improve reliability, and maintain strong TypeScript typing across application boundaries.
