// LINT CANARY: each `expect:` line must be reported by exactly that rule, or the lint gate refuses to run.
export function same(a: number, b: number): boolean {
  return a == b; // expect: eqeqeq
}
