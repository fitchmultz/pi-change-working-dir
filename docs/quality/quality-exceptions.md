# Quality exceptions

This repository adopts [Strict Oxlint and Oxfmt Engineering Standard v5.1.2](strict-oxlint-oxfmt-5.1.2.md).
Recorded exceptions are listed below using the standard's Appendix B template. Each site directive in
the recorded inventory carries its exception id; `npm run policy:check` fails when a directive is
unrecorded, miscounted, or appears anywhere else.

## QX-001 — no-param-reassign on host-mutable shared objects

```text
ID and title:
  QX-001 — in-place mutation of host-owned mutable objects at the extension API's documented seams.

Rule, option, or threshold; installed tool versions:
  eslint/no-param-reassign. oxlint 1.90.0; oxlint-tsgolint 7.0.2005 (type-aware); oxfmt 0.75.0;
  oxc-parser 0.156.0.

Scope: files, authorized operations, origins, or bounded pattern:
  cwd-context.ts (2), index.ts (1), tool-wrapper.ts (4). Authorized operations: writing
  systemPromptOptions.cwd and systemPromptOptions.sections.cwd during before_agent_start (the host
  documents systemPromptOptions as mutable during the event); assigning request.result on the
  resolve/set channel requests (the channel contract delivers results through that field);
  rebinding input.path on admitted tool arguments (the admission contract requires in-place argument
  mutation); writing workingDirectory/workingTarget on the shared per-row render state (ToolRenderContext
  state is shared renderer state by the host's own declaration); and rewriting a delegated error's
  message in place (the wrapper owns that error instance and preserves its identity).

Directive selectors/inventory and optional duplication bounds:
  Seven single-rule next-line directives, each tagged QX-001: two in cwd-context.ts, one in index.ts,
  four in tool-wrapper.ts. Recorded counts live in scripts/policy-baseline.ts.

Diagnostic and required contract:
  The checker reports "Assignment to property of function parameter" at each site. Each target object
  is owned by the host and documented as mutable at that seam; no local copy can substitute because
  the host reads the same object (tool arguments are validated in place, render state is shared across
  callbacks, channel results are awaited by the requester).

Actual compliant alternative and demonstrated quality cost:
  Rebuilding copies (spread-then-return, or return-value plumbing instead of mutation) breaks the
  contracts above: the host's tool_call admission validates the mutated event.input object, the
  renderer re-reads ctx.state across renders, and the channel caller awaits the exact request object.
  Aliasing the parameter to a local evades the rule without changing the mutation, which the standard
  forbids as directive laundering.

Chosen adjustment and why its scope is appropriate:
  Per-site next-line directives with the narrowest possible span (the single assignment expression),
  each justified by a named host contract. No rule-level allowance; the rule stays fully active
  everywhere else, including all future code.

Structural comparison or unsafe-type evidence, where applicable:
  Not a structural exception.

Verification commands, relevant tests, and results:
  npm run policy:check (directives exactly as inventoried); npm run typecheck; npm test —
  test-render.ts asserts the rebound input.path and render-state publication, test.ts asserts the
  channel round-trip and journal persistence, test-context.ts asserts the projected system sections.

Retained protection, lost detection, and established assumptions:
  Retained: the rule remains enabled everywhere, flags any new parameter mutation, and the inventory
  count fails policy:check if a directive is copied to a new site. Lost detection: none beyond the
  seven inventoried assignments, each of which mutates a host-owned object by contract.

Review and revisit trigger:
  Any host release that changes these seams (admission mutation, render-state sharing, channel
  results, systemPromptOptions mutability), or any new site that needs the same treatment — which
  requires a new inventory entry and an updated count here.
```

## QX-002 — max-params on the host-fixed tool execute signature

```text
ID and title:
  QX-002 — five positional parameters on ToolDefinition.execute implementations.

Rule, option, or threshold; installed tool versions:
  eslint/max-params (max 4). oxlint 1.90.0; oxlint-tsgolint 7.0.2005 (type-aware); oxfmt 0.75.0;
  oxc-parser 0.156.0.

Scope: files, authorized operations, origins, or bounded pattern:
  index.ts (1), tool-wrapper.ts (1). Authorized operations: the execute method bodies of the wrapped
  native tools and the change_dir tool. The host's ToolDefinition.execute signature fixes five
  positional parameters (toolCallId, params, signal, onUpdate, ctx); an implementation cannot drop,
  merge, or reorder them.

Directive selectors/inventory and optional duplication bounds:
  Two single-rule next-line directives, each tagged QX-002, recorded in scripts/policy-baseline.ts.

Diagnostic and required contract:
  The checker reports "Function has too many parameters (5). Maximum allowed is 4" on each execute
  implementation. The parameter list is the host's interface, not a repository decision.

Actual compliant alternative and demonstrated quality cost:
  No compliant alternative exists: the signatures are host-fixed. The trailing ctx parameter is
  required, so the count cannot drop below five without abandoning parameters the host passes
  positionally.

Chosen adjustment and why its scope is appropriate:
  Per-site directives on exactly the two execute implementations the repository defines. The rule
  stays active and still guards every other function.

Structural comparison or unsafe-type evidence, where applicable:
  Not a structural exception.

Verification commands, relevant tests, and results:
  npm run policy:check; npm run typecheck (the implementations contextually match the host's
  ToolDefinition.execute); npm test drives both execute paths end to end.

Retained protection, lost detection, and established assumptions:
  Retained: every other function in the repository is still limited to four parameters. Lost
  detection: a future six-parameter function would still be flagged; only exactly-five host execute
  overrides are exempted, and only at the two inventoried sites.

Review and revisit trigger:
  Any host release that changes the ToolDefinition.execute arity, or any new tool the repository
  defines (requires a new inventory entry).
```

## QX-003 — no-useless-undefined for required-position undefined arguments

```text
ID and title:
  QX-003 — explicit undefined arguments in required value positions of host APIs.

Rule, option, or threshold; installed tool versions:
  unicorn/no-useless-undefined (checkArguments true). oxlint 1.90.0; oxlint-tsgolint 7.0.2005
  (type-aware); oxfmt 0.75.0; oxc-parser 0.156.0.

Scope: files, authorized operations, origins, or bounded pattern:
  index.ts (1), selection.ts (1). Authorized operations: ctx.ui.setStatus("cwd", undefined) when the
  selection is cleared — the host's setStatus declares the value parameter as
  `string | undefined` in a required position, so clearing the slot needs the literal argument. The
  two sites are the live status update and the shutdown cleanup.

Directive selectors/inventory and optional duplication bounds:
  Two single-rule next-line directives, each tagged QX-003, recorded in scripts/policy-baseline.ts.

Diagnostic and required contract:
  The checker reports "Do not use useless `undefined`" for the argument. The installed checker does
  not distinguish required-position `string | undefined` slots from optional ones here, so the
  diagnostic is a false positive for this API shape: omitting the argument is a type error because
  the parameter is not optional.

Actual compliant alternative and demonstrated quality cost:
  There is no compliant alternative at these call sites. The parameter is required and typed to
  include undefined; passing a non-undefined value would show a stale slot instead of clearing it.

Chosen adjustment and why its scope is appropriate:
  Per-site directives on exactly the two clearing calls. The rule stays active and still flags
  removable undefined elsewhere, including optional-parameter positions.

Structural comparison or unsafe-type evidence, where applicable:
  Not a structural exception. The host declaration is the ui context's
  setStatus(key: string, value: string | undefined).

Verification commands, relevant tests, and results:
  npm run policy:check; npm run typecheck (removing the argument fails compilation); npm test
  asserts the status slot's cleared and populated renderings.

Retained protection, lost detection, and established assumptions:
  Retained: the rule still flags every other undefined argument, including optional positions where
  omission is meaningful. Lost detection: none — the two exempted arguments cannot be omitted.

Review and revisit trigger:
  Any host release that makes the setStatus value parameter optional, or any new required-position
  undefined argument (requires a new inventory entry and record update).
```

## QX-004 — no-unsafe-type-assertion at host-typing boundaries

```text
ID and title:
  QX-004 — two assertions bridging host API typing that variance rules cannot express.

Rule, option, or threshold; installed tool versions:
  typescript/no-unsafe-type-assertion. oxlint 1.90.0; oxlint-tsgolint 7.0.2005 (type-aware);
  oxfmt 0.75.0; oxc-parser 0.156.0.

Scope: files, authorized operations, origins, or bounded pattern:
  tool-wrapper.ts (2). Authorized operations: (1) the execution context view built with Object.create —
  prototype inheritance is the only mechanism that keeps the host context's live getters while
  overriding cwd, and Object.create's return type is any; (2) the widened definition view inside wrap —
  the native renderers read only their own details fields while the wrapper's receipt fields
  (workingDirectory and friends) are additive and inert to them, but TypeScript's variance rules
  cannot express that the enriched results are acceptable to the native renderResult.

Directive selectors/inventory and optional duplication bounds:
  Two single-rule next-line directives, each tagged QX-004, recorded in scripts/policy-baseline.ts.

Diagnostic and required contract:
  The checker reports the assertions as unsafe narrowing. Both sites cross boundaries where the
  static types disagree for structural reasons (any-typed factory returns; deferred-generic
  variance), while the runtime objects satisfy both views — verified by the host's own
  wrapToolDefinition, which performs the same widening with any-typed parameters.

Actual compliant alternative and demonstrated quality cost:
  For the context view, spreading the context would snapshot host-owned live state and change
  behavior. For the definition view, no honest construction exists: constructing an
  AgentToolResult<TDetails> from a fresh details literal inside a generic body is unprovable, and
  re-typing every wrapped call site would re-introduce any-typed wrappers the standard forbids.

Chosen adjustment and why its scope is appropriate:
  Two per-site assertions, each immediately documented with the boundary it bridges. No rule-level
  allowance; every other assertion in the repository remains flagged.

Structural comparison or unsafe-type evidence, where applicable:
  The wrapper preserves the native parameter schema (TParams) and render-state contracts exactly;
  only the details type widens by the additive receipt. The delegated write/edit factories return
  concrete details types that the merge reconstructs without assertion (see withWorkingDetails).

Verification commands, relevant tests, and results:
  npm run policy:check; npm run typecheck; npm test — test.ts and test-render.ts assert the
  receipt fields and the native-renderer pass-through end to end, so a mistyped bridge fails tests.

Retained protection, lost detection, and established assumptions:
  Retained: every other type assertion in the repository is still flagged. Lost detection: the two
  bridged sites would not catch a host change that makes the views genuinely incompatible — which
  npm test covers behaviorally instead.

Review and revisit trigger:
  Any host release that re-types Object.create, tool definition generics, or wrapToolDefinition;
  the assertions should be re-examined and ideally removed.
```

No other exceptions exist. Structural thresholds, formatter settings, and the baseline rule set are
the standard's own values. Test-profile allowances and test-file directives, if any become
necessary, will be recorded here with their own ids.
