# Zod Repository Overview

## What this is

**Zod** is a Node.js and browser visualization project that combines an interactive “inverse metaverse” canvas with an MCP server and CI/CD-style pipeline state controls. The browser renders nested icosahedron-like vector shells, while `Server.js` exposes tools for search, data validation, transfer chunking, and pipeline coordination.

The project is GPL-3.0 licensed.

## Stack

- **Languages:** JavaScript, HTML, and Makefile automation
- **Runtime:** Node.js ES modules
- **Frontend tooling:** Vite 6
- **Notable libraries:** Zod 3.24.1, `@modelcontextprotocol/sdk` 1.11, and `ws` 8.18

## Repository structure

```text
inverse_metaverse.html  Interactive canvas UI, styles, and browser-side logic
Server.js               MCP server, WebSocket bridge, search, validation, and pipeline tools
package.json            npm scripts and dependencies
vite.config.js          Vite development/build configuration
Makefile                Development task wrappers
README.md               Project concept, structure, workflow, and accessibility notes
Abstract.txt            Short project notes
Zod Documentation.txt   Supplementary documentation
LICENSE                 GNU General Public License v3.0
```

## How it fits together

`inverse_metaverse.html` uses an HTML canvas to display a rotating collection of nested wireframe vector shells. Its stage controls, inverse-depth warp control, and vector-density control update the visualization. The page is built with Vite and includes keyboard navigation, a skip link, live status announcements, responsive layout behavior, and reduced-motion support.

`Server.js` maintains shared pipeline state and bridges browser updates through a WebSocket server on port `8765`. It also exposes MCP tools over stdio. These tools include pipeline stage updates, vector parameter changes, a simulated CI/CD instruction pointer, data repair and filtering, bounded transfer chunk preparation, and DuckDuckGo search.

The `scrape_and_vectorize` tool scrapes search results, validates URLs, repairs safe omissions, tiers records by completeness, computes checksums, derives canvas parameters from the query and results, and broadcasts the updated state to connected browsers.

## How to run it

```bash
npm install
npm run dev
```

The Vite development site is available at `http://127.0.0.1:4173/`.

Other useful commands:

```bash
npm run build    # Produce the dist/ build
npm run preview  # Preview the production build
npm start        # Run Server.js
npm test         # Run Node's built-in tests
npm run lint     # Syntax-check Server.js and vite.config.js
```

The server entry point can expose MCP tools through stdio and a WebSocket bridge on port `8765`.

## Development notes

- The Makefile wraps npm install, build, test, lint, and clean operations.
- Vite uses `inverse_metaverse.html` as the build entry point.
- For GitHub Pages builds, Vite sets the base path to `/Zod/`.
- The server's in-memory integrity state is revalidated every five minutes without network or filesystem access.
- CI/CD, repair, containerization, transfer, and deployment operations are represented as pipeline state rather than executed as shell commands.
