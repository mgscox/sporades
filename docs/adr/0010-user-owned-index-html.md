# User-owned index.html, not generated

Status: Superseded by ADR-0032.

The scaffold includes an `index.html` at the project root. Sporades serves it at `/` and serves the client bundle at `/client.js`. The user owns the HTML — they can add meta tags, fonts, analytics, or any custom markup. Sporades does not generate HTML at runtime. The HTML must contain `<div id="app">` and `<script type="module" src="/client.js">` for the app to mount.

ADR 0032 preserves user ownership of source HTML while replacing this fixed
runtime-file contract with a toolchain-built normalized public asset tree.
