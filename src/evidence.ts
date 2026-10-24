/** JSON Pointer over unmodified tool data. MCP text envelopes may contain JSON. */
export function pointer(input: unknown, location: string): unknown {
  if (location === '') return input;
  if (!location.startsWith('/')) throw new Error('证据绑定必须使用 JSON Pointer');
  let current = input;
  for (const segment of location.slice(1).split('/')) {
    if (typeof current === 'string') {
      try { current = JSON.parse(current); } catch { throw new Error(`证据字段不是结构化 JSON: ${location}`); }
    }
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new Error(`原始证据缺少字段: ${location}`);
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function toolObjectPath(args: unknown, explicitPointer?: unknown): unknown {
  if (explicitPointer !== undefined) {
    if (typeof explicitPointer !== 'string') throw new Error('pathArgumentPointer 必须为字符串');
    return pointer(args, explicitPointer);
  }
  if (!args || typeof args !== 'object') throw new Error('工具参数缺少对象路径');
  const values = ['path', 'objectPath', 'object_path'].filter(k => Object.hasOwn(args, k)).map(k => (args as Record<string, unknown>)[k]);
  if (values.length !== 1) throw new Error('工具参数缺少唯一对象路径；需根据实际 schema 指定 pathArgumentPointer');
  return values[0];
}

/** Bind normalized compile fields to actual raw fields; never accept a caller's summary alone. */
export function verifyCompileEvidence(data: Record<string, unknown>, evidence: Record<string, unknown>): void {
  const binding = data.bindings as Record<string, unknown> | undefined;
  if (!binding || typeof binding !== 'object') throw new Error('完整编译需要 bindings 绑定原始参数和诊断字段');
  const field = (key: string): string => {
    if (typeof binding[key] !== 'string') throw new Error(`缺少编译证据绑定 ${key}`);
    return binding[key] as string;
  };
  const fullValue = pointer(evidence.arguments, field('fullBuildArgument'));
  if (fullValue !== true && fullValue !== 'full') throw new Error('实际工具参数没有请求完整编译');
  const errors = pointer(evidence.result, field('errorCountResult'));
  const warnings = pointer(evidence.result, field('warningCountResult'));
  if (errors !== data.errorCount || warnings !== data.warningCount) throw new Error('归一化错误/警告总数与原始编译结果不符');
  const raw = pointer(evidence.result, field('diagnosticsResult'));
  if (!Array.isArray(raw)) throw new Error('原始编译诊断必须是完整数组；文本格式需先实现明确解析适配器');
  const normalized = data.diagnostics as Array<Record<string, unknown>>;
  if (raw.length !== normalized.length) throw new Error('编译诊断与原始结果条数不符');
  const severityKey = typeof binding.severityKey === 'string' ? binding.severityKey : 'severity';
  const messageKey = typeof binding.messageKey === 'string' ? binding.messageKey : 'message';
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    if (!item || String(item[severityKey]).toLowerCase() !== normalized[i]?.severity || item[messageKey] !== normalized[i]?.message) throw new Error('编译诊断内容与原始结果不符');
  }
}
