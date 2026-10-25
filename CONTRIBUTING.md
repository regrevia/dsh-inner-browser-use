# Contributing

## The page half is a classic script

`client.js` is served to the app's page as a plain script, not a module: no
`import`, no `export`, no top-level `await`. A single `export` parses fine under
Node's ESM loader and fails in the page, which takes the whole app down on its
next reload. `test/client.test.mjs` parses the file with `node:vm` for exactly
this reason — keep that check first.

## Before you push

```sh
npm test
node ~/.dsh/skills/ui-restraint/scripts/ui-copy-lint.mjs .
```
