export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

/** Line-based LCS diff from `a` (old) to `b` (new). Falls back to whole replace for huge inputs. */
export function diffLines(a: string, b: string): DiffOp[] {
  const x = a.split('\n'), y = b.split('\n');
  if (x.length * y.length > 4_000_000) return [...x.map((text) => ({ type: 'del' as const, text })), ...y.map((text) => ({ type: 'add' as const, text }))];
  const n = x.length, m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { ops.push({ type: 'same', text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ type: 'del', text: x[i++] });
    else ops.push({ type: 'add', text: y[j++] });
  }
  while (i < n) ops.push({ type: 'del', text: x[i++] });
  while (j < m) ops.push({ type: 'add', text: y[j++] });
  return ops;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  return { added: ops.filter((o) => o.type === 'add').length, removed: ops.filter((o) => o.type === 'del').length };
}
