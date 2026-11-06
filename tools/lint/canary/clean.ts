// LINT CANARY: a file with NO finding (the gate must not cry wolf on correct code).
async function work(): Promise<number> {
  return 1;
}
export async function caller(a: number, b: number): Promise<boolean> {
  const n = await work();
  return a === b && n === 1;
}
