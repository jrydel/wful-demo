/** Compares secrets in constant time: the loop always covers the whole expected value. */
export function constantTimeEqual(actual: string, expected: string): boolean {
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (const [i, byte] of b.entries()) difference |= byte ^ (a[i] ?? 0);
  return difference === 0;
}
