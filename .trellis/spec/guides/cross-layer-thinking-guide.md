# Cross-Layer Thinking Guide

## Map the Flow

Write the actual path before editing:

```text
key/argv -> parser/view -> service -> core/contract -> file or child process
         <- typed result/progress <- postflight facts <- mutation
         -> reducer reconciliation -> view/footer/CLI exit
```

For installer/Release work use:

```text
source -> contract -> builder -> dist artifact -> CI/Release -> installed runtime
```

## Boundary Checklist

- [ ] What is the exact input and who validates it?
- [ ] Which layer owns persistence or process execution?
- [ ] What fields/files belong to another domain and must be preserved?
- [ ] Are missing and corrupt states distinct?
- [ ] Does exit code need filesystem/runtime postflight?
- [ ] Can the result be partial, restored, scheduled or cancelled?
- [ ] Which side effects require snapshot/atomic write/cleanup?
- [ ] How are secrets redacted across progress, error, toast and CLI output?
- [ ] Is final UI state reconciled from current facts?

## Project-Specific Boundaries

### Config

Provider, Config, MCP, Skills and Global Rules are separate owners. A general
config save must not serialize a reduced model over another domain.

### Shared Agent Resources

Tools/MCP/Skills show two-sided facts but each has a different physical model.
Do not reuse one domain's projection or injection assumption in another.

### External CLIs

Command construction, environment, timeout, TTY and diagnostic capture are part
of the contract. Official Skills/CodeGraph/CcgWorkflow commands also require
postflight facts; stdout/stderr alone is not state.

### Compiled Runtime

Source paths, dynamic workers and adjacent contract files may not exist in a Bun
single-file executable. Every source-mode asset path needs an embedded/plain
fallback and a compiled smoke.

### Windows Release

Source PowerShell and `irm | iex` have different path/encoding contexts. Test
both whenever build composition, contracts, templates or remote entry code moves.

## After the Change

- [ ] Focused boundary assertions exist on both sides.
- [ ] A corrupt/partial/error case proves no unrelated mutation.
- [ ] Registry/help/footer/contract projections still share one source.
- [ ] Source and compiled/platform-specific paths are both covered.
