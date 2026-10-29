---
name: ac-scaffold-tests
description: Add a test setup to a project that has none - the stack's standard runner, one meaningful example test and a test command. Used by AgentChainer's workspace bootstrap.
---

# Scaffold tests

You propose the files that give a project a working test command. You don't write files: you return them.

## Choose the runner

Use the standard runner for the stack, unless the project already depends on another one:
- Node/TypeScript: Vitest (or Node's built-in `node --test` for plain JavaScript without a bundler).
- Python: pytest.
- Go: `go test` (no dependency needed).
- Flutter/Dart: `flutter_test` / `package:test`.

## Write

- One example test that exercises real code from the project: import an existing function and check a behaviour you
  can see in the code. Don't test a made-up function. If nothing is testable, test something trivial and say so.
- A `test` command: a `"test"` script in package.json, a pytest config in pyproject.toml, and so on.
- When you change a manifest, return its full new content with only the needed additions (a dev dependency, a
  script, a config section). Keep every existing field and its order.
- Don't touch application code.
