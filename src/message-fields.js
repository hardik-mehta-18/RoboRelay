export function createMessageFields(inspect) {
  const schemas = new Map();
  const samples = new Map();

  function fromDefinition(type, ancestors = new Set()) {
    if (ancestors.has(type)) return null;
    if (schemas.has(type)) return schemas.get(type);

    let fields;
    try {
      fields = inspect(type);
    } catch {
      schemas.set(type, null);
      return null;
    }

    const parents = new Set([...ancestors, type]);
    const result = fields.map(({ name, type: field }) => ({
      name,
      ...(field.isArray && { array: true }),
      children: field.isArray || field.isPrimitiveType ? null
        : fromDefinition(`${field.pkgName}/msg/${field.type}`, parents)
    }));
    schemas.set(type, result);
    return result;
  }

  function fromObject(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    return Object.entries(message).map(([name, value]) => ({
      name,
      ...(Array.isArray(value) && { array: true }),
      children: fromObject(value)
    }));
  }

  return {
    observe(id, type, message) {
      if (fromDefinition(type) === null && !samples.has(id)) {
        const fields = fromObject(message);
        if (fields?.length) samples.set(id, fields);
      }
    },
    get(id, type) {
      return fromDefinition(type) ?? samples.get(id) ?? null;
    }
  };
}
