export interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  enum?: string[];
  description?: string;
  default?: any;
}

export function getDefault(schema: SchemaNode): any {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case 'string': return '';
    case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': {
      const obj: Record<string, any> = {};
      if (schema.properties) {
        for (const [k, v] of Object.entries(schema.properties)) {
          obj[k] = getDefault(v);
        }
      }
      return obj;
    }
    default: return '';
  }
}
