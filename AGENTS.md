# Agent notes

- TypeScript, ES modules. Shared code in `shared/`, one Telnyx Edge function per folder in `functions/`.
- Unit tests use Node's built-in runner through tsx (the sources use extensionless imports): `npm test`. No other test framework.
- Never put secrets, phone numbers or API keys in files. `.env` is local only.
- Keep changes small; match the comment density and naming of the surrounding code.
