# dayzero app

The SvelteKit PWA frontend for dayzero. See the [repo root README](../README.md)
for prerequisites, the dev shell, and an overview of the whole project.

```sh
npm install
npm run dev -- --open
```

| command             | what it does                                |
| ------------------- | ------------------------------------------- |
| `npm run build`     | production build (static files in `build/`) |
| `npm run preview`   | serve the production build locally          |
| `npm run check`     | svelte-check (types + Svelte diagnostics)   |
| `npm run lint`      | prettier --check + eslint                   |
| `npm run format`    | prettier --write                            |
| `npm run test`      | vitest, single run                          |
| `npm run test:unit` | vitest in watch mode                        |
