export type Verdict = {
  pass: boolean;
  label?: string;
  suggest: 'pass' | 'review' | 'block';
  provider: string;
  /** 微信图片审核已提交、尚未收到回调 */
  pending?: boolean;
  traceId?: string;
};

export function mapSuggest(suggest: string | undefined, label: unknown, provider: string): Verdict {
  const text = label == null || label === '' ? undefined : String(label);
  if (suggest === 'pass') return { pass: true, suggest: 'pass', provider, label: text };
  if (suggest === 'review') return { pass: false, suggest: 'review', provider, label: text ?? 'review' };
  return { pass: false, suggest: 'block', provider, label: text ?? suggest ?? 'risky' };
}
