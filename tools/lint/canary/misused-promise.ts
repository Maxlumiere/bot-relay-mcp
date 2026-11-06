// LINT CANARY: each `expect:` line must be reported by exactly that rule, or the lint gate refuses to run.
export function check(p: Promise<boolean>): number {
  if (p) return 1; // expect: @typescript-eslint/no-misused-promises
  return 0;
}
