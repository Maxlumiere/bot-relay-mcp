// LINT CANARY: each `expect:` line must be reported by exactly that rule, or the lint gate refuses to run.
export function value(): number {
  const leftover = 1; // expect: @typescript-eslint/no-unused-vars
  return 2;
}
