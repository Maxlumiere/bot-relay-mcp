// LINT CANARY: each `expect:` line must be reported by exactly that rule, or the lint gate refuses to run.
async function work(): Promise<number> {
  return 1;
}
export function caller(): void {
  work(); // expect: @typescript-eslint/no-floating-promises
}
