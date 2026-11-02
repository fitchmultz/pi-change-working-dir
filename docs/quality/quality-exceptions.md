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
  cwd-context.ts (2), tool-wrapper.ts (3), test-context.ts (2). Authorized operations: writing
  systemPromptOptions.cwd and systemPromptOptions.sections.cwd during before_agent_start (the host
  documents systemPromptOptions as mutable during the event) — once in the production projector and
  once in the test's own before_agent_start factory; rebinding input.path on admitted tool arguments
  (the admission contract requires in-place argument mutation); and writing workingDirectory/
  workingTarget on the shared per-row render state (ToolRenderContext state is shared renderer
  state by the host's own declaration). The resolve/set channel handlers assign request.result on a
  narrowed local alias, and the delegated-error rewrite targets a catch binding, so neither needs
  this exemption.

Directive selectors/inventory and optional duplication bounds:
  Seven single-rule next-line directives, each tagged QX-001: two in cwd-context.ts, three in
  tool-wrapper.ts, two in test-context.ts. Recorded counts live in scripts/policy-baseline.ts.

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

## QX-003 — no-useless-undefined where the installed checker flags required-position undefined

```text
ID and title:
  QX-003 — explicit undefined arguments in required value positions of host APIs.

Rule, option, or threshold; installed tool versions:
  unicorn/no-useless-undefined (checkArguments true). oxlint 1.90.0; oxlint-tsgolint 7.0.2005
  (type-aware); oxfmt 0.75.0; oxc-parser 0.156.0.

Scope: files, authorized operations, origins, or bounded pattern:
  test.ts (5), test-paths.ts (6), test-context.ts (2), test-bash.ts (1), test-render.ts (1).
  Authorized operations: passing undefined as the second argument to
  session.extensionRunner.createToolContext — the host declares that parameter as
  `AbortSignal | undefined` in a required position, so omitting it is a type error — and returning
  undefined from the resource-loader stubs' getSystemPrompt/getSystemPromptSource, whose contract
  declares a required `string | undefined` return. The production setStatus call sites use the same
  required-undefined shape but the installed checker does not flag them, so they carry no
  directives.

Directive selectors/inventory and optional duplication bounds:
  Fifteen single-rule next-line directives, each tagged QX-003, recorded in scripts/policy-baseline.ts.

Diagnostic and required contract:
  The checker reports "Do not use useless `undefined`" for the argument or return. It does not
  distinguish these required-undefined slots from removable ones, so the diagnostic is a false
  positive for this API shape: omitting the argument (or return) is a type error because the
  position is not optional.

Actual compliant alternative and demonstrated quality cost:
  There is no compliant alternative at these call sites. The parameter is required and typed to
  include undefined; passing a non-undefined value would show a stale slot instead of clearing it.

Chosen adjustment and why its scope is appropriate:
  Per-site directives on exactly the fifteen inventoried call and return sites. The rule stays
  active and still flags removable undefined elsewhere, including optional-parameter positions.

Structural comparison or unsafe-type evidence, where applicable:
  Not a structural exception. The host declaration is the ui context's
  setStatus(key: string, value: string | undefined).

Verification commands, relevant tests, and results:
  npm run policy:check; npm run typecheck (omitting the createToolContext argument or the loader
  stub returns fails compilation); npm test drives every inventoried createToolContext site.

Retained protection, lost detection, and established assumptions:
  Retained: the rule still flags every other undefined argument and return, including optional
  positions where omission is meaningful. Lost detection: none — the fifteen exempted arguments and
  returns cannot be omitted.

Review and revisit trigger:
  Any oxlint or oxlint-tsgolint upgrade that changes which required-undefined positions are flagged
  (the two production setStatus sites became unflagged between qualification runs), or any host
  release that makes these parameters optional.
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

## QX-007 — node:test registration allowance in the test profile

```text
ID and title:
  QX-007 — node:test registration allowance on the test-profile override.

Rule, option, or threshold; installed tool versions:
  typescript/no-floating-promises with allowForKnownSafeCalls =
  [{from: "package", package: "@types/node", name: [nodeTest, nodeIt, nodeDescribe, nodeSuite]}].
  oxlint 1.90.0; oxlint-tsgolint 7.0.2005 (type-aware); oxfmt 0.75.0; oxc-parser 0.156.0.

Scope: files, authorized operations, origins, or bounded pattern:
  The test-profile override in .oxlintrc.json (test*.ts and the standard's test-file patterns).
  Authorized operations: top-level test registrations made through those four mapped local names.
  Nothing else in the file changes; every other rule and option in the baseline stays exactly as
  the standard sets it.

Directive selectors/inventory and optional duplication bounds:
  No directives are used. Four mapped names, one package origin, test profile only.

Diagnostic and required contract:
  An un-awaited `nodeTest(...)` registration reports "Promises must be awaited". The registration
  is fire-and-forget by design: the node:test runner owns the returned promise, schedules the
  test, and reports the result through its own reporter, so awaiting it is not the contract. The
  test files import the framework under the mapped names for this reason.

Actual compliant alternative and demonstrated quality cost:
  The compliant alternative is `void nodeTest(...)` (or `await`) at every registration site,
  because ignoreVoid and every other option stay at the baseline. That adds non-semantic ceremony
  to every registration in the repository while removing no real risk. The standard defines this
  mapping for precisely this case (Section 6.4), so the allowance is the narrower choice: it
  exempts four named functions instead of silencing the rule for a file, a directory, or the
  whole test profile.

Chosen adjustment and why its scope is appropriate:
  Declaration-qualified allowance limited to the four names the repository actually uses, applied
  only in the test profile. Production sources keep the rule unrestricted.

Structural comparison or unsafe-type evidence, where applicable:
  Not a structural exception. Type flow is the standard's own example mapping, narrowed to the
  names in use (see lost detection below).

Verification commands, relevant tests, and results:
  The qualification controls in test-quality.ts cover the floating-promise protection with a real
  violation (async-floating.ts reports exactly one diagnostic) and valid counterparts
  (async-owned.ts, async-unknown-forward.ts report zero). test-quality.ts itself registers
  through the mapped names and passes the checker.

Retained protection, lost detection, and established assumptions:
  Retained: all other floating-promise options (ignoreVoid false, ignoreIIFE false,
  checkThenables true, allowForKnownSafePromises empty) plus every other rule in both profiles.
  Lost detection: registrations using shorthand modifiers through a mapped alias are not exempted
  (adding them to the name list makes the installed checker panic when a shorthand is called
  through a mapped alias). The repository uses none; a new one will surface as an ordinary
  finding in `npm run lint`.

Review and revisit trigger:
  Any upgrade of oxlint or oxlint-tsgolint, any new registration form, or the first use of a
  shorthand modifier through a mapped name. Re-measure with the qualification controls and update
  this record.
```

No other exceptions exist. Structural thresholds, formatter settings, and the baseline rule set are
the standard's own values. Test-profile allowances and test-file directives, if any become
necessary, will be recorded here with their own ids.
