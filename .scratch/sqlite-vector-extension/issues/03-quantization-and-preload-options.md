Status: ready-for-agent

# Quantization and Preload Options

## Parent

.scratch/sqlite-vector-extension/PRD.md

## What to build

Per-field quantization and preload configuration for vector fields, with
conservative defaults (no quantization, no preload). Quantized columns stay
correct through the write→store→nearest-neighbor path; preload makes declared
vector data memory-resident at adapter initialization. Fix and document the
exact configuration vocabulary as part of this slice.

## Acceptance criteria

- [ ] A vector field can declare a quantization option; storage and nearest-neighbor results remain correct (allowing documented quantization-induced distance tolerance).
- [ ] A vector field can declare preload behavior applied at adapter initialization.
- [ ] Defaults are no quantization and no preload; existing vector fields are unaffected when the options are absent.
- [ ] Invalid option values fail schema validation with structured errors.
- [ ] Adapter-seam tests cover quantized round-trip and query correctness; capsule-session tests cover a quantized end-to-end search.
- [ ] Docs define the option vocabulary, defaults, and trade-offs.

## Blocked by

- .scratch/sqlite-vector-extension/issues/01-vector-field-storage-and-extension-load.md
